import AppKit
import CoreGraphics
import Foundation
import QuickLookThumbnailing

private let thumbPalette: [CGColor] = [
    CGColor(red: 0.12, green: 0.47, blue: 0.71, alpha: 1.0),
    CGColor(red: 1.00, green: 0.50, blue: 0.05, alpha: 1.0),
    CGColor(red: 0.17, green: 0.63, blue: 0.17, alpha: 1.0),
    CGColor(red: 0.84, green: 0.15, blue: 0.16, alpha: 1.0),
    CGColor(red: 0.58, green: 0.40, blue: 0.74, alpha: 1.0),
    CGColor(red: 0.55, green: 0.34, blue: 0.29, alpha: 1.0),
    CGColor(red: 0.89, green: 0.47, blue: 0.76, alpha: 1.0),
    CGColor(red: 0.09, green: 0.75, blue: 0.81, alpha: 1.0),
    CGColor(red: 0.74, green: 0.74, blue: 0.13, alpha: 1.0),
]

@objc(SLEAPThumbnailProvider)
public final class ThumbnailProvider: QLThumbnailProvider {
    public override func provideThumbnail(
        for request: QLFileThumbnailRequest,
        _ handler: @escaping (QLThumbnailReply?, Error?) -> Void
    ) {
        do {
            let box = try SLPHandleBox(url: request.fileURL)
            let summary = box.summary
            let bestIdx = box.bestFrameIndex()
            let entry = bestIdx.map { summary.preview_frames[$0] }
            let poses = entry?.row_idx.flatMap { box.loadFramePoses(rowIdx: $0) }
            let loadedImg = entry.flatMap { e in
                e.hasAnyImage ? box.loadFrameImage(videoIdx: e.video_idx, frameIdx: e.frame_idx) : nil
            }

            let (srcW, srcH, originX, originY) = computeThumbBounds(image: loadedImg, poses: poses)
            let aspect = srcW / max(srcH, 1.0)
            let maxW = request.maximumSize.width
            let maxH = request.maximumSize.height
            let drawSize: CGSize
            if maxW / max(maxH, 1.0) > aspect {
                drawSize = CGSize(width: max(16, (maxH * aspect).rounded()), height: maxH)
            } else {
                drawSize = CGSize(width: maxW, height: max(16, (maxW / aspect).rounded()))
            }

            let skeletons = summary.skeletons
            let badgeText: String = summary.is_pkg ? "PKG" : (summary.is_format3 ? "SLP 3" : "SLP")
            let backingScale = max(1.0, request.scale)

            let reply = QLThumbnailReply(contextSize: drawSize) { ctx in
                // QLThumbnailReply(contextSize:drawing:) allocates contextSize * scale pixels
                // without pre-scaling the CTM, so apply backingScale if CTM is still 1x.
                if abs(ctx.ctm.a - 1.0) < 0.01 && backingScale > 1.0 {
                    ctx.scaleBy(x: backingScale, y: backingScale)
                }
                let rect = CGRect(origin: .zero, size: drawSize)

                // Background
                ctx.setFillColor(CGColor(red: 0.09, green: 0.10, blue: 0.12, alpha: 1.0))
                ctx.fill(rect)

                // Draw frame image if available, else subtle grid
                if let loaded = loadedImg {
                    ctx.interpolationQuality = .high
                    ctx.draw(loaded.image, in: rect)
                } else {
                    ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.08))
                    ctx.setLineWidth(max(1.0, drawSize.width / 256.0))
                    for i in 1..<4 {
                        let gx = rect.width * CGFloat(i) / 4.0
                        ctx.move(to: CGPoint(x: gx, y: 0))
                        ctx.addLine(to: CGPoint(x: gx, y: rect.height))
                        let gy = rect.height * CGFloat(i) / 4.0
                        ctx.move(to: CGPoint(x: 0, y: gy))
                        ctx.addLine(to: CGPoint(x: rect.width, y: gy))
                    }
                    ctx.strokePath()
                }

                let scaleX = rect.width / CGFloat(srcW)
                let scaleY = rect.height / CGFloat(srcH)

                // Map top-left image coords -> CoreGraphics bottom-left coords
                func mapPt(_ x: Double, _ y: Double) -> CGPoint {
                    CGPoint(
                        x: CGFloat(x - originX) * scaleX,
                        y: rect.height - CGFloat(y - originY) * scaleY
                    )
                }

                if let poses = poses {
                    let thumbMaxR = max(2.2, min(4.2, min(rect.width, rect.height) * 0.011))
                    let thumbMinR = max(1.0, min(2.0, min(rect.width, rect.height) * 0.0045))
                    let metrics = adaptivePoseMetrics(
                        poses: poses,
                        skeletons: skeletons,
                        scaleX: scaleX,
                        scaleY: scaleY,
                        minRadius: thumbMinR,
                        maxRadius: thumbMaxR
                    )

                    // Bounding boxes
                    for (bIdx, bb) in poses.bboxes.enumerated() {
                        let p1 = mapPt(bb.x1, bb.y1)
                        let p2 = mapPt(bb.x2, bb.y2)
                        let bRect = CGRect(
                            x: min(p1.x, p2.x),
                            y: min(p1.y, p2.y),
                            width: abs(p2.x - p1.x),
                            height: abs(p2.y - p1.y)
                        )
                        let color = thumbPalette[abs(bb.track_idx ?? bIdx) % thumbPalette.count]
                        ctx.saveGState()
                        ctx.setStrokeColor(color)
                        ctx.setLineWidth(metrics.bboxWidth)
                        if bb.is_predicted {
                            ctx.setLineDash(phase: 0, lengths: [4.5, 2.5])
                        }
                        ctx.stroke(bRect)
                        ctx.restoreGState()
                    }

                    // Poses
                    for (iIdx, inst) in poses.instances.enumerated() {
                        let color = thumbPalette[abs(inst.track_idx ?? iIdx) % thumbPalette.count]
                        let skel = skeletons.indices.contains(inst.skeleton_idx)
                            ? skeletons[inst.skeleton_idx]
                            : skeletons.first

                        // Edges
                        if let skel = skel {
                            ctx.saveGState()
                            ctx.setStrokeColor(color.copy(alpha: 0.88) ?? color)
                            ctx.setLineWidth(metrics.edgeWidth)
                            ctx.setLineCap(.round)
                            if inst.is_predicted {
                                ctx.setLineDash(phase: 0, lengths: [3.5, 2.0])
                            }
                            for edge in skel.edges where edge.count == 2 {
                                let a = edge[0], b = edge[1]
                                guard a < inst.points.count, b < inst.points.count else { continue }
                                let pa = inst.points[a], pb = inst.points[b]
                                guard pa.visible && pb.visible else { continue }
                                ctx.move(to: mapPt(pa.x, pa.y))
                                ctx.addLine(to: mapPt(pb.x, pb.y))
                            }
                            ctx.strokePath()
                            ctx.restoreGState()
                        }

                        // Nodes
                        let r = inst.is_predicted ? metrics.nodeRadius * 0.88 : metrics.nodeRadius
                        for pt in inst.points where pt.visible {
                            let c = mapPt(pt.x, pt.y)
                            let dot = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
                            ctx.setFillColor(color.copy(alpha: 0.92) ?? color)
                            ctx.fillEllipse(in: dot)
                            ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.6))
                            ctx.setLineWidth(metrics.nodeStrokeWidth)
                            ctx.strokeEllipse(in: dot)
                        }
                    }
                }

                // Subtle bottom-left badge on thumbnails >= 96px
                if min(rect.width, rect.height) >= 96 {
                    let fontSize = max(9.0, min(rect.width, rect.height) * 0.055)
                    let attrs: [NSAttributedString.Key: Any] = [
                        .font: NSFont.systemFont(ofSize: fontSize, weight: .bold),
                        .foregroundColor: NSColor.white,
                    ]
                    let attrStr = NSAttributedString(string: badgeText, attributes: attrs)
                    let textSize = attrStr.size()
                    let padX = fontSize * 0.55
                    let padY = fontSize * 0.25
                    let pillW = textSize.width + padX * 2
                    let pillH = textSize.height + padY * 2
                    let margin = fontSize * 0.65
                    let pillRect = CGRect(x: margin, y: margin, width: pillW, height: pillH)

                    let pillPath = CGPath(roundedRect: pillRect, cornerWidth: pillH * 0.35, cornerHeight: pillH * 0.35, transform: nil)
                    ctx.setFillColor(CGColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.68))
                    ctx.addPath(pillPath)
                    ctx.fillPath()

                    NSGraphicsContext.saveGraphicsState()
                    NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
                    attrStr.draw(at: CGPoint(x: pillRect.minX + padX, y: pillRect.minY + padY))
                    NSGraphicsContext.restoreGraphicsState()
                }

                return true
            }
            handler(reply, nil)
        } catch {
            handler(nil, error)
        }
    }
}

private func computeThumbBounds(
    image: LoadedFrameImage?,
    poses: FramePoses?
) -> (Double, Double, Double, Double) {
    if let loaded = image, loaded.origWidth > 0, loaded.origHeight > 0 {
        return (Double(loaded.origWidth), Double(loaded.origHeight), 0, 0)
    }
    if let w = poses?.width, let h = poses?.height, w > 0, h > 0 {
        return (Double(w), Double(h), 0, 0)
    }
    var minX = Double.infinity
    var minY = Double.infinity
    var maxX = -Double.infinity
    var maxY = -Double.infinity
    if let poses = poses {
        for inst in poses.instances {
            for pt in inst.points where pt.visible {
                minX = min(minX, pt.x)
                minY = min(minY, pt.y)
                maxX = max(maxX, pt.x)
                maxY = max(maxY, pt.y)
            }
        }
        for bb in poses.bboxes {
            minX = min(minX, min(bb.x1, bb.x2))
            minY = min(minY, min(bb.y1, bb.y2))
            maxX = max(maxX, max(bb.x1, bb.x2))
            maxY = max(maxY, max(bb.y1, bb.y2))
        }
    }
    if minX.isFinite && maxX > minX && maxY > minY {
        let pad = max(maxX - minX, maxY - minY) * 0.2
        return ((maxX - minX) + pad * 2, (maxY - minY) + pad * 2, minX - pad, minY - pad)
    }
    return (512, 512, 0, 0)
}
