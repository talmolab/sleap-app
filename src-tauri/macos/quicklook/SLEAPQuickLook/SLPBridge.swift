import AppKit
import CoreGraphics
import Foundation
import ImageIO

// MARK: - Decodable models mirroring slp_ql_core JSON

struct SlpSummary: Decodable {
    let path: String
    let filename: String
    let file_size_bytes: UInt64
    let format_id: Double
    let sleap_version: String
    let is_format3: Bool
    let is_pkg: Bool
    let has_preview_images: Bool
    let preview_image_count: Int
    let skeletons: [SkeletonInfo]
    let tracks: [String]
    let videos: [VideoInfo]
    let counts: CountsInfo
    let provenance_summary: [[String]]
    let preview_frames: [PreviewFrameEntry]
    let timeline_bins: [UInt32]
    let open_ms: Double
}

struct SkeletonInfo: Decodable, Identifiable {
    var id: String { "\(name)-\(nodes.count)" }
    let name: String
    let nodes: [String]
    let edges: [[Int]]
    let symmetries: [[Int]]
}

struct VideoInfo: Decodable, Identifiable {
    var id: Int { index }
    let index: Int
    let filename: String
    let display_name: String
    let dataset: String?
    let embedded: Bool
    let embedded_frame_count: Int
    let format: String?
    let width: UInt32?
    let height: UInt32?
    let channels: UInt32?
    let frame_count: UInt64?
    let fps: Double?
    let channel_order: String?
    let labeled_frame_count: Int
}

struct CountsInfo: Decodable {
    let labeled_frames: Int
    let negative_frames: Int
    let instances: Int
    let user_instances: Int
    let predicted_instances: Int
    let user_points: Int
    let predicted_points: Int
    let tracks: Int
    let videos: Int
    let embedded_videos: Int
    let suggestions: Int
    let sessions: Int
    let identities: Int
    let categories: Int
    let bboxes: Int
    let masks: Int
    let rois: Int
    let label_images: Int
    let events: Int
}

struct PreviewFrameEntry: Decodable, Identifiable, Equatable {
    var id: String { "\(video_idx)-\(frame_idx)-\(row_idx ?? -1)" }
    let row_idx: Int?
    let video_idx: Int
    let frame_idx: UInt64
    let instance_count: Int
    let has_embedded_image: Bool
    let has_preview_image: Bool
    let is_negative: Bool
    var hasAnyImage: Bool { has_embedded_image || has_preview_image }
}

struct FramePoses: Decodable {
    let row_idx: Int
    let video_idx: Int
    let frame_idx: UInt64
    let width: UInt32?
    let height: UInt32?
    let instances: [InstancePose]
    let bboxes: [BBoxPose]
}

struct InstancePose: Decodable {
    let is_predicted: Bool
    let skeleton_idx: Int
    let track_idx: Int?
    let score: Double?
    let points: [PointPose]
}

struct PointPose: Decodable {
    let x: Double
    let y: Double
    let visible: Bool
    let verified: Bool
    let score: Double?
}

struct BBoxPose: Decodable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
    let is_predicted: Bool
    let track_idx: Int?
    let score: Double?
}

struct LoadedFrameImage {
    let image: CGImage
    let origWidth: Int
    let origHeight: Int
    let isPreview: Bool
}

struct PoseDrawMetrics {
    let nodeRadius: CGFloat
    let nodeStrokeWidth: CGFloat
    let edgeWidth: CGFloat
    let bboxWidth: CGFloat
}

/// Compute screen-space marker radius and line widths scaled to the actual
/// skeleton density on screen so small/dense animals (e.g., 13- or 24-node flies
/// in a 1024x1024 arena) stay crisp without obscuring the animal underneath.
func adaptivePoseMetrics(
    poses: FramePoses,
    skeletons: [SkeletonInfo],
    scaleX: CGFloat,
    scaleY: CGFloat,
    minRadius: CGFloat = 1.5,
    maxRadius: CGFloat = 3.4
) -> PoseDrawMetrics {
    var edgeLengths: [CGFloat] = []
    var fallbackSpans: [CGFloat] = []

    for inst in poses.instances {
        let skel = skeletons.indices.contains(inst.skeleton_idx)
            ? skeletons[inst.skeleton_idx]
            : skeletons.first

        if let skel = skel {
            for edge in skel.edges where edge.count == 2 {
                let a = edge[0], b = edge[1]
                guard a < inst.points.count, b < inst.points.count else { continue }
                let pa = inst.points[a], pb = inst.points[b]
                guard pa.visible && pb.visible else { continue }
                let dx = CGFloat(pb.x - pa.x) * scaleX
                let dy = CGFloat(pb.y - pa.y) * scaleY
                let len = hypot(dx, dy)
                if len > 0.5 {
                    edgeLengths.append(len)
                }
            }
        }

        let vis = inst.points.filter { $0.visible }
        if vis.count >= 2 {
            let xs = vis.map { CGFloat($0.x) * scaleX }
            let ys = vis.map { CGFloat($0.y) * scaleY }
            let diag = hypot((xs.max()! - xs.min()!), (ys.max()! - ys.min()!))
            if diag > 1.0 {
                fallbackSpans.append(diag / sqrt(CGFloat(vis.count)))
            }
        }
    }

    let refLen: CGFloat
    if !edgeLengths.isEmpty {
        edgeLengths.sort()
        // Use 35th percentile so dense body/leg edges govern marker size
        refLen = edgeLengths[Int(Double(edgeLengths.count - 1) * 0.35)]
    } else if !fallbackSpans.isEmpty {
        fallbackSpans.sort()
        refLen = fallbackSpans[fallbackSpans.count / 2]
    } else {
        refLen = 24.0
    }

    let r = min(maxRadius, max(minRadius, refLen * 0.115))
    let edgeW = min(2.0, max(0.85, r * 0.58))
    let strokeW = max(0.35, min(0.85, r * 0.22))
    let bboxW = min(1.8, max(1.0, edgeW * 1.05))
    return PoseDrawMetrics(
        nodeRadius: r,
        nodeStrokeWidth: strokeW,
        edgeWidth: edgeW,
        bboxWidth: bboxW
    )
}

extension SLPHandleBox {
    func bestFrameIndex() -> Int? {
        let frames = summary.preview_frames
        guard !frames.isEmpty else { return nil }
        return frames.firstIndex(where: { $0.has_embedded_image && $0.instance_count > 0 })
            ?? frames.firstIndex(where: { $0.has_preview_image && $0.instance_count > 0 })
            ?? frames.firstIndex(where: { $0.hasAnyImage })
            ?? frames.firstIndex(where: { $0.instance_count > 0 })
            ?? 0
    }
}

final class SLPHandleBox: @unchecked Sendable {
    private let handle: OpaquePointer
    private let lock = NSLock()
    private let scopedURL: URL?

    let summary: SlpSummary

    init(url: URL) throws {
        let didScope = url.startAccessingSecurityScopedResource()
        self.scopedURL = didScope ? url : nil

        var errPtr: UnsafeMutablePointer<CChar>? = nil
        let opened = url.path.withCString { cPath in
            slp_open(cPath, &errPtr)
        }
        guard let rawHandle = opened else {
            let msg: String
            if let errPtr = errPtr {
                msg = String(cString: errPtr)
                slp_free_string(errPtr)
            } else {
                msg = "Failed to open SLP file"
            }
            if didScope { url.stopAccessingSecurityScopedResource() }
            throw NSError(domain: "org.sleap.quicklook", code: 1, userInfo: [NSLocalizedDescriptionKey: msg])
        }

        self.handle = rawHandle

        guard let summaryPtr = slp_summary_json(rawHandle) else {
            slp_close(rawHandle)
            if didScope { url.stopAccessingSecurityScopedResource() }
            throw NSError(domain: "org.sleap.quicklook", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to serialize SLP summary"])
        }
        defer { slp_free_string(summaryPtr) }

        let data = Data(bytes: summaryPtr, count: strlen(summaryPtr))
        do {
            self.summary = try JSONDecoder().decode(SlpSummary.self, from: data)
        } catch {
            slp_close(rawHandle)
            if didScope { url.stopAccessingSecurityScopedResource() }
            throw error
        }
    }

    deinit {
        lock.lock()
        slp_close(handle)
        lock.unlock()
        scopedURL?.stopAccessingSecurityScopedResource()
    }

    func loadFramePoses(rowIdx: Int) -> FramePoses? {
        guard rowIdx >= 0 && rowIdx < Int.max else { return nil }
        lock.lock()
        let ptr = slp_frame_poses_json(handle, rowIdx)
        lock.unlock()
        guard let ptr = ptr else { return nil }
        defer { slp_free_string(ptr) }
        let data = Data(bytes: ptr, count: strlen(ptr))
        return try? JSONDecoder().decode(FramePoses.self, from: data)
    }

    func loadFrameImage(videoIdx: Int, frameIdx: UInt64) -> LoadedFrameImage? {
        var buf = SlpImageBuf(
            data: nil,
            len: 0,
            kind: 0,
            width: 0,
            height: 0,
            channels: 0,
            is_bgr: 0,
            orig_width: 0,
            orig_height: 0,
            is_preview: 0
        )
        lock.lock()
        let status = slp_frame_image(handle, videoIdx, frameIdx, &buf)
        lock.unlock()

        guard status == 1, let dataPtr = buf.data, buf.len > 0 else {
            if status == 1 { slp_free_image(buf) }
            return nil
        }
        defer { slp_free_image(buf) }

        let rawData = Data(bytes: dataPtr, count: buf.len)
        let isBGR = buf.is_bgr != 0
        let isPreview = buf.is_preview != 0
        let decoded: CGImage?

        if buf.kind == 0 {
            // Encoded PNG or JPEG bytes
            guard let source = CGImageSourceCreateWithData(rawData as CFData, nil),
                  let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else {
                return nil
            }
            if isBGR && cgImage.colorSpace?.model == .rgb {
                decoded = swapRedBlue(cgImage) ?? cgImage
            } else {
                decoded = cgImage
            }
        } else {
            // Raw interleaved pixel array (1, 3, or 4 channels)
            decoded = decodeRawPixels(
                rawData,
                width: Int(buf.width),
                height: Int(buf.height),
                channels: Int(buf.channels),
                isBGR: isBGR
            )
        }

        guard let cg = decoded else { return nil }
        let ow = buf.orig_width > 0 ? Int(buf.orig_width) : cg.width
        let oh = buf.orig_height > 0 ? Int(buf.orig_height) : cg.height
        return LoadedFrameImage(image: cg, origWidth: ow, origHeight: oh, isPreview: isPreview)
    }
}

private func swapRedBlue(_ image: CGImage) -> CGImage? {
    let w = image.width
    let h = image.height
    guard w > 0, h > 0 else { return nil }
    let bytesPerRow = w * 4
    var pixels = [UInt8](repeating: 0, count: bytesPerRow * h)
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue

    guard let ctx = CGContext(
        data: &pixels,
        width: w,
        height: h,
        bitsPerComponent: 8,
        bytesPerRow: bytesPerRow,
        space: colorSpace,
        bitmapInfo: bitmapInfo
    ) else { return nil }

    ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
    for i in stride(from: 0, to: pixels.count, by: 4) {
        let r = pixels[i]
        pixels[i] = pixels[i + 2]
        pixels[i + 2] = r
    }
    return ctx.makeImage()
}

private func decodeRawPixels(
    _ raw: Data,
    width: Int,
    height: Int,
    channels: Int,
    isBGR: Bool
) -> CGImage? {
    guard width > 0, height > 0 else { return nil }
    let n = width * height
    guard raw.count >= n * max(channels, 1) else { return nil }

    var rgba = [UInt8](repeating: 255, count: n * 4)
    raw.withUnsafeBytes { ptr in
        guard let src = ptr.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return }
        if channels == 1 {
            for i in 0..<n {
                let v = src[i]
                rgba[i * 4] = v
                rgba[i * 4 + 1] = v
                rgba[i * 4 + 2] = v
            }
        } else if channels >= 3 {
            for i in 0..<n {
                let s = i * channels
                let c0 = src[s]
                let c1 = src[s + 1]
                let c2 = src[s + 2]
                rgba[i * 4] = isBGR ? c2 : c0
                rgba[i * 4 + 1] = c1
                rgba[i * 4 + 2] = isBGR ? c0 : c2
                if channels >= 4 {
                    rgba[i * 4 + 3] = src[s + 3]
                }
            }
        }
    }

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    let bitmapInfo = CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
    guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
    return CGImage(
        width: width,
        height: height,
        bitsPerComponent: 8,
        bitsPerPixel: 32,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGBitmapInfo(rawValue: bitmapInfo),
        provider: provider,
        decode: nil,
        shouldInterpolate: true,
        intent: .defaultIntent
    )
}
