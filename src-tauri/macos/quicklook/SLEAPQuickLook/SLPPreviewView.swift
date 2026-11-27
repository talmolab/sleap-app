import AppKit
import SwiftUI

// MARK: - View Model

final class SLPPreviewModel: ObservableObject {
    let box: SLPHandleBox
    var summary: SlpSummary { box.summary }

    @Published var currentIndex: Int = 0
    @Published var currentPoses: FramePoses?
    @Published var currentImage: LoadedFrameImage?
    @Published var showPoses: Bool = true
    @Published var showLabels: Bool = false
    @Published var showBBoxes: Bool = true
    @Published var viewMode: ViewportMode = .frame

    enum ViewportMode: String, CaseIterable {
        case frame = "Frame"
        case skeleton = "Skeleton"
    }

    private let loadQueue = DispatchQueue(label: "org.sleap.quicklook.frame", qos: .userInitiated)
    private var requestToken: Int = 0

    var firstPreviewImageIndex: Int? {
        summary.preview_frames.firstIndex(where: { $0.has_preview_image })
    }

    init(box: SLPHandleBox) {
        self.box = box
        if let best = box.bestFrameIndex() {
            self.currentIndex = best
        }
        // Synchronously load the initial frame so Quick Look has content before first paint
        loadFrameSync(index: currentIndex)
        if box.summary.preview_frames.isEmpty && !box.summary.skeletons.isEmpty {
            self.viewMode = .skeleton
        }
    }

    var currentEntry: PreviewFrameEntry? {
        guard currentIndex >= 0 && currentIndex < summary.preview_frames.count else { return nil }
        return summary.preview_frames[currentIndex]
    }

    func selectFrame(index: Int) {
        guard !summary.preview_frames.isEmpty else { return }
        let clamped = max(0, min(index, summary.preview_frames.count - 1))
        if clamped == currentIndex && (currentPoses != nil || currentImage != nil) {
            return
        }
        currentIndex = clamped
        requestToken += 1
        let token = requestToken
        let entry = summary.preview_frames[clamped]
        let box = self.box

        loadQueue.async { [weak self] in
            let poses = entry.row_idx.flatMap { box.loadFramePoses(rowIdx: $0) }
            let img = entry.hasAnyImage
                ? box.loadFrameImage(videoIdx: entry.video_idx, frameIdx: entry.frame_idx)
                : nil
            DispatchQueue.main.async {
                guard let self = self, self.requestToken == token else { return }
                self.currentPoses = poses
                self.currentImage = img
            }
        }
    }

    private func loadFrameSync(index: Int) {
        guard index >= 0 && index < summary.preview_frames.count else { return }
        let entry = summary.preview_frames[index]
        self.currentPoses = entry.row_idx.flatMap { box.loadFramePoses(rowIdx: $0) }
        self.currentImage = entry.hasAnyImage
            ? box.loadFrameImage(videoIdx: entry.video_idx, frameIdx: entry.frame_idx)
            : nil
    }
}

// MARK: - SLEAP Color Palette (matches sleap-io.js standard palette)

private let sleapPalette: [Color] = [
    Color(red: 0.12, green: 0.47, blue: 0.71), // blue
    Color(red: 1.00, green: 0.50, blue: 0.05), // orange
    Color(red: 0.17, green: 0.63, blue: 0.17), // green
    Color(red: 0.84, green: 0.15, blue: 0.16), // red
    Color(red: 0.58, green: 0.40, blue: 0.74), // purple
    Color(red: 0.55, green: 0.34, blue: 0.29), // brown
    Color(red: 0.89, green: 0.47, blue: 0.76), // pink
    Color(red: 0.09, green: 0.75, blue: 0.81), // cyan
    Color(red: 0.74, green: 0.74, blue: 0.13), // olive
    Color(red: 0.68, green: 0.78, blue: 0.91), // light blue
]

private func colorForInstance(_ inst: InstancePose, index: Int) -> Color {
    let idx = inst.track_idx ?? index
    return sleapPalette[abs(idx) % sleapPalette.count]
}

// MARK: - Main Preview View

struct SLPPreviewView: View {
    @ObservedObject var model: SLPPreviewModel

    var body: some View {
        VStack(spacing: 0) {
            HeaderBar(model: model)
            Divider()
            HStack(spacing: 0) {
                ViewportPane(model: model)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                Divider()
                InspectorSidebar(model: model)
                    .frame(width: 268)
            }
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: - Header Bar

private struct HeaderBar: View {
    @ObservedObject var model: SLPPreviewModel

    var body: some View {
        let s = model.summary
        HStack(spacing: 10) {
            Image(systemName: s.is_pkg ? "film.stack.fill" : "point.3.connected.trianglepath.dotted")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.orange)

            VStack(alignment: .leading, spacing: 1) {
                Text(s.filename)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                    .truncationMode(.middle)
                HStack(spacing: 6) {
                    Text(formatBytes(s.file_size_bytes))
                    Text("·")
                    Text("SLEAP \(s.sleap_version)")
                    Text("·")
                    Text(String(format: "%.1f ms", s.open_ms))
                }
                .font(.system(size: 10.5))
                .foregroundStyle(.secondary)
            }

            Spacer()

            BadgePill(
                text: String(format: "SLP %.1f", s.format_id),
                tint: s.is_format3 ? .purple : .blue
            )
            BadgePill(
                text: s.is_pkg
                    ? "PKG · Embedded"
                    : (s.has_preview_images ? "Linked · Preview" : "Linked"),
                tint: s.is_pkg ? .green : (s.has_preview_images ? .teal : .secondary)
            )

            Picker("", selection: $model.viewMode) {
                ForEach(SLPPreviewModel.ViewportMode.allCases, id: \.self) { m in
                    Text(m.rawValue).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 138)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.65))
    }
}

private struct BadgePill: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10.5, weight: .medium, design: .rounded))
            .padding(.horizontal, 7)
            .padding(.vertical, 2.5)
            .background(tint.opacity(0.14))
            .foregroundStyle(tint)
            .clipShape(Capsule())
    }
}

// MARK: - Viewport Pane

private struct ViewportPane: View {
    @ObservedObject var model: SLPPreviewModel

    var body: some View {
        VStack(spacing: 0) {
            ZStack {
                Color(red: 0.08, green: 0.085, blue: 0.10)

                if model.viewMode == .skeleton {
                    SkeletonGraphCanvas(skeletons: model.summary.skeletons)
                        .padding(20)
                } else if model.summary.preview_frames.isEmpty {
                    EmptyFramesPlaceholder(summary: model.summary)
                } else {
                    FramePoseCanvas(
                        image: model.currentImage,
                        poses: model.currentPoses,
                        skeletons: model.summary.skeletons,
                        tracks: model.summary.tracks,
                        showPoses: model.showPoses,
                        showLabels: model.showLabels,
                        showBBoxes: model.showBBoxes
                    )
                    .padding(12)

                    // Subtle status overlays
                    VStack {
                        HStack {
                            if let entry = model.currentEntry {
                                let vidName = model.summary.videos.indices.contains(entry.video_idx)
                                    ? model.summary.videos[entry.video_idx].display_name
                                    : "Video \(entry.video_idx)"
                                OverlayTag(text: "\(vidName) · Frame \(entry.frame_idx)")
                            }
                            Spacer()
                            if let loaded = model.currentImage, loaded.isPreview {
                                let dimText = (loaded.image.width != loaded.origWidth || loaded.image.height != loaded.origHeight)
                                    ? "Preview · \(loaded.image.width)×\(loaded.image.height) → \(loaded.origWidth)×\(loaded.origHeight)"
                                    : "Preview · \(loaded.image.width)×\(loaded.image.height)"
                                OverlayTag(text: dimText, icon: "photo")
                            } else if model.currentImage == nil {
                                if let prevIdx = model.firstPreviewImageIndex {
                                    Button {
                                        model.selectFrame(index: prevIdx)
                                    } label: {
                                        OverlayTag(
                                            text: "Wireframe · Jump to preview frame",
                                            icon: "photo.badge.arrow.down"
                                        )
                                    }
                                    .buttonStyle(.plain)
                                } else {
                                    OverlayTag(
                                        text: "Pose wireframe (no embedded preview)",
                                        icon: "video.slash"
                                    )
                                }
                            }
                        }
                        Spacer()
                    }
                    .padding(10)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)

            if model.viewMode == .frame && !model.summary.preview_frames.isEmpty {
                Divider()
                ScrubberBar(model: model)
            }
        }
    }
}

private struct OverlayTag: View {
    let text: String
    var icon: String? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let icon = icon {
                Image(systemName: icon)
                    .font(.system(size: 10))
            }
            Text(text)
                .font(.system(size: 10.5, weight: .medium))
                .lineLimit(1)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .background(.black.opacity(0.58))
        .foregroundStyle(.white.opacity(0.9))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct EmptyFramesPlaceholder: View {
    let summary: SlpSummary

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "square.dashed")
                .font(.system(size: 32))
                .foregroundStyle(.white.opacity(0.35))
            Text("No labeled frames in this project")
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(.white.opacity(0.75))
            Text("\(summary.counts.videos) video(s) · \(summary.skeletons.count) skeleton(s)")
                .font(.system(size: 11.5))
                .foregroundStyle(.white.opacity(0.45))
        }
    }
}

// MARK: - Frame + Pose Canvas

private struct FramePoseCanvas: View {
    let image: LoadedFrameImage?
    let poses: FramePoses?
    let skeletons: [SkeletonInfo]
    let tracks: [String]
    let showPoses: Bool
    let showLabels: Bool
    let showBBoxes: Bool

    var body: some View {
        Canvas { ctx, size in
            // Compute data coordinate space
            let (srcW, srcH, originX, originY) = computeBounds()
            guard srcW > 0, srcH > 0, size.width > 1, size.height > 1 else { return }

            let scale = min(size.width / srcW, size.height / srcH)
            let drawW = srcW * scale
            let drawH = srcH * scale
            let offsetX = (size.width - drawW) * 0.5
            let offsetY = (size.height - drawH) * 0.5
            let frameRect = CGRect(x: offsetX, y: offsetY, width: drawW, height: drawH)

            func mapPt(_ x: Double, _ y: Double) -> CGPoint {
                CGPoint(
                    x: offsetX + (x - originX) * scale,
                    y: offsetY + (y - originY) * scale
                )
            }

            if let loaded = image {
                let cgImg = loaded.image
                let nsImg = NSImage(cgImage: cgImg, size: NSSize(width: cgImg.width, height: cgImg.height))
                ctx.draw(Image(nsImage: nsImg), in: frameRect)
            } else {
                // Subtle frame canvas + coordinate grid for non-embedded linked .slp
                let bgPath = Path(roundedRect: frameRect, cornerRadius: 4)
                ctx.fill(bgPath, with: .color(Color(red: 0.11, green: 0.12, blue: 0.145)))
                ctx.stroke(bgPath, with: .color(.white.opacity(0.16)), lineWidth: 1)

                var gridPath = Path()
                let step = 4
                for i in 1..<step {
                    let gx = frameRect.minX + frameRect.width * CGFloat(i) / CGFloat(step)
                    gridPath.move(to: CGPoint(x: gx, y: frameRect.minY))
                    gridPath.addLine(to: CGPoint(x: gx, y: frameRect.maxY))
                    let gy = frameRect.minY + frameRect.height * CGFloat(i) / CGFloat(step)
                    gridPath.move(to: CGPoint(x: frameRect.minX, y: gy))
                    gridPath.addLine(to: CGPoint(x: frameRect.maxX, y: gy))
                }
                ctx.stroke(gridPath, with: .color(.white.opacity(0.05)), lineWidth: 0.75)
            }

            guard let poses = poses else { return }

            let metrics = adaptivePoseMetrics(
                poses: poses,
                skeletons: skeletons,
                scaleX: scale,
                scaleY: scale,
                minRadius: 1.5,
                maxRadius: 3.4
            )

            // Draw bounding boxes
            if showBBoxes {
                for (bIdx, bb) in poses.bboxes.enumerated() {
                    let p1 = mapPt(bb.x1, bb.y1)
                    let p2 = mapPt(bb.x2, bb.y2)
                    let rect = CGRect(
                        x: min(p1.x, p2.x),
                        y: min(p1.y, p2.y),
                        width: abs(p2.x - p1.x),
                        height: abs(p2.y - p1.y)
                    )
                    let c = sleapPalette[abs(bb.track_idx ?? bIdx) % sleapPalette.count]
                    let style = bb.is_predicted
                        ? StrokeStyle(lineWidth: metrics.bboxWidth, dash: [4.5, 3])
                        : StrokeStyle(lineWidth: metrics.bboxWidth)
                    ctx.stroke(Path(rect), with: .color(c.opacity(0.85)), style: style)
                }
            }

            // Draw pose skeletons & keypoints
            if showPoses {
                for (iIdx, inst) in poses.instances.enumerated() {
                    let color = colorForInstance(inst, index: iIdx)
                    let alpha: Double = inst.is_predicted ? 0.78 : 0.90
                    let skel = skeletons.indices.contains(inst.skeleton_idx)
                        ? skeletons[inst.skeleton_idx]
                        : skeletons.first

                    // Edges
                    if let skel = skel {
                        var edgePath = Path()
                        for edge in skel.edges where edge.count == 2 {
                            let a = edge[0]
                            let b = edge[1]
                            guard a < inst.points.count, b < inst.points.count else { continue }
                            let pa = inst.points[a]
                            let pb = inst.points[b]
                            guard pa.visible && pb.visible else { continue }
                            edgePath.move(to: mapPt(pa.x, pa.y))
                            edgePath.addLine(to: mapPt(pb.x, pb.y))
                        }
                        let edgeStyle = inst.is_predicted
                            ? StrokeStyle(lineWidth: metrics.edgeWidth, lineCap: .round, dash: [3.5, 2.5])
                            : StrokeStyle(lineWidth: metrics.edgeWidth, lineCap: .round)
                        ctx.stroke(edgePath, with: .color(color.opacity(alpha)), style: edgeStyle)
                    }

                    // Nodes
                    let radius = inst.is_predicted ? metrics.nodeRadius * 0.88 : metrics.nodeRadius
                    for (pIdx, pt) in inst.points.enumerated() where pt.visible {
                        let cPt = mapPt(pt.x, pt.y)
                        let circle = Path(
                            ellipseIn: CGRect(
                                x: cPt.x - radius,
                                y: cPt.y - radius,
                                width: radius * 2,
                                height: radius * 2
                            )
                        )
                        if inst.is_predicted {
                            ctx.fill(circle, with: .color(color.opacity(0.45)))
                            ctx.stroke(circle, with: .color(color.opacity(0.95)), lineWidth: max(0.75, metrics.nodeStrokeWidth * 1.4))
                        } else {
                            ctx.fill(circle, with: .color(color.opacity(0.92)))
                            ctx.stroke(circle, with: .color(.white.opacity(0.65)), lineWidth: metrics.nodeStrokeWidth)
                        }

                        if showLabels, let skel = skel, pIdx < skel.nodes.count {
                            let label = Text(skel.nodes[pIdx])
                                .font(.system(size: 9, weight: .medium))
                                .foregroundColor(.white)
                            ctx.draw(label, at: CGPoint(x: cPt.x + radius + 3, y: cPt.y - radius - 2), anchor: .bottomLeading)
                        }
                    }

                    // Optional track badge near centroid
                    if let tid = inst.track_idx, tid < tracks.count {
                        let visPts = inst.points.filter { $0.visible }
                        if !visPts.isEmpty {
                            let cx = visPts.map { $0.x }.reduce(0, +) / Double(visPts.count)
                            let minY = visPts.map { $0.y }.min() ?? 0
                            let anchor = mapPt(cx, minY)
                            let tagText = Text(tracks[tid])
                                .font(.system(size: 9.5, weight: .semibold))
                                .foregroundColor(color)
                            ctx.draw(tagText, at: CGPoint(x: anchor.x, y: max(12, anchor.y - 8)), anchor: .bottom)
                        }
                    }
                }
            }
        }
    }

    private func computeBounds() -> (Double, Double, Double, Double) {
        if let loaded = image, loaded.origWidth > 0, loaded.origHeight > 0 {
            return (Double(loaded.origWidth), Double(loaded.origHeight), 0, 0)
        }
        if let w = poses?.width, let h = poses?.height, w > 0, h > 0 {
            return (Double(w), Double(h), 0, 0)
        }
        // Fallback: fit tightly around visible points & bboxes
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
            let pad = max(maxX - minX, maxY - minY) * 0.18
            return ((maxX - minX) + pad * 2, (maxY - minY) + pad * 2, minX - pad, minY - pad)
        }
        return (512, 512, 0, 0)
    }
}

// MARK: - Scrubber + Timeline Sparkline

private struct ScrubberBar: View {
    @ObservedObject var model: SLPPreviewModel

    var body: some View {
        let count = model.summary.preview_frames.count
        VStack(spacing: 6) {
            if !model.summary.timeline_bins.isEmpty && model.summary.counts.labeled_frames > 1 {
                TimelineSparkline(
                    bins: model.summary.timeline_bins,
                    progress: count > 1 ? Double(model.currentIndex) / Double(count - 1) : 0
                )
                .frame(height: 14)
            }

            HStack(spacing: 8) {
                Button {
                    model.selectFrame(index: model.currentIndex - 1)
                } label: {
                    Image(systemName: "chevron.left")
                }
                .buttonStyle(.borderless)
                .disabled(model.currentIndex <= 0)

                if count > 1 {
                    Slider(
                        value: Binding(
                            get: { Double(model.currentIndex) },
                            set: { model.selectFrame(index: Int($0.rounded())) }
                        ),
                        in: 0...Double(count - 1),
                        step: 1
                    )
                    .controlSize(.small)
                } else {
                    Spacer()
                }

                Button {
                    model.selectFrame(index: model.currentIndex + 1)
                } label: {
                    Image(systemName: "chevron.right")
                }
                .buttonStyle(.borderless)
                .disabled(model.currentIndex >= count - 1)

                Text("\(model.currentIndex + 1) / \(count)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.secondary)
                    .frame(minWidth: 54, alignment: .trailing)

                Divider().frame(height: 14)

                Toggle("Poses", isOn: $model.showPoses)
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                    .font(.system(size: 11))

                Toggle("Names", isOn: $model.showLabels)
                    .toggleStyle(.checkbox)
                    .controlSize(.small)
                    .font(.system(size: 11))
                    .disabled(!model.showPoses)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(nsColor: .controlBackgroundColor).opacity(0.65))
    }
}

private struct TimelineSparkline: View {
    let bins: [UInt32]
    let progress: Double

    var body: some View {
        Canvas { ctx, size in
            let maxVal = max(1, bins.max() ?? 1)
            let w = size.width / CGFloat(bins.count)
            for (i, val) in bins.enumerated() {
                let h = val == 0 ? 1.5 : max(2.5, size.height * CGFloat(val) / CGFloat(maxVal))
                let rect = CGRect(
                    x: CGFloat(i) * w + 0.5,
                    y: size.height - h,
                    width: max(1, w - 1.5),
                    height: h
                )
                ctx.fill(
                    Path(roundedRect: rect, cornerRadius: 1),
                    with: .color(val > 0 ? Color.orange.opacity(0.75) : Color.secondary.opacity(0.18))
                )
            }
            let x = CGFloat(progress) * size.width
            var marker = Path()
            marker.move(to: CGPoint(x: x, y: 0))
            marker.addLine(to: CGPoint(x: x, y: size.height))
            ctx.stroke(marker, with: .color(.primary), lineWidth: 1.5)
        }
    }
}

// MARK: - Skeleton Topology View

private struct SkeletonGraphCanvas: View {
    let skeletons: [SkeletonInfo]

    var body: some View {
        if let skel = skeletons.first, !skel.nodes.isEmpty {
            VStack(spacing: 8) {
                Text("\(skel.name) — \(skel.nodes.count) nodes, \(skel.edges.count) edges")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white.opacity(0.85))
                Canvas { ctx, size in
                    let n = skel.nodes.count
                    let cx = size.width * 0.5
                    let cy = size.height * 0.5
                    let r = min(size.width, size.height) * 0.36
                    var pts: [CGPoint] = []
                    for i in 0..<n {
                        let angle = (Double(i) / Double(max(n, 1))) * 2.0 * .pi - .pi / 2.0
                        pts.append(CGPoint(x: cx + r * cos(angle), y: cy + r * sin(angle)))
                    }

                    // Symmetries (dashed subtle purple)
                    var symPath = Path()
                    for s in skel.symmetries where s.count == 2 && s[0] < n && s[1] < n {
                        symPath.move(to: pts[s[0]])
                        symPath.addLine(to: pts[s[1]])
                    }
                    ctx.stroke(
                        symPath,
                        with: .color(.purple.opacity(0.5)),
                        style: StrokeStyle(lineWidth: 1.2, dash: [4, 4])
                    )

                    // Edges
                    var edgePath = Path()
                    for e in skel.edges where e.count == 2 && e[0] < n && e[1] < n {
                        edgePath.move(to: pts[e[0]])
                        edgePath.addLine(to: pts[e[1]])
                    }
                    ctx.stroke(edgePath, with: .color(.orange.opacity(0.85)), lineWidth: 2)

                    // Nodes + labels
                    for i in 0..<n {
                        let p = pts[i]
                        let c = sleapPalette[i % sleapPalette.count]
                        let dot = Path(ellipseIn: CGRect(x: p.x - 5, y: p.y - 5, width: 10, height: 10))
                        ctx.fill(dot, with: .color(c))
                        ctx.stroke(dot, with: .color(.white), lineWidth: 1.2)

                        let angle = (Double(i) / Double(max(n, 1))) * 2.0 * .pi - .pi / 2.0
                        let lx = cx + (r + 18) * cos(angle)
                        let ly = cy + (r + 18) * sin(angle)
                        let txt = Text(skel.nodes[i])
                            .font(.system(size: 10, weight: .medium))
                            .foregroundColor(.white.opacity(0.9))
                        ctx.draw(txt, at: CGPoint(x: lx, y: ly), anchor: .center)
                    }
                }
            }
        } else {
            Text("No skeletons defined")
                .foregroundStyle(.white.opacity(0.5))
        }
    }
}

// MARK: - Inspector Sidebar

private struct InspectorSidebar: View {
    @ObservedObject var model: SLPPreviewModel

    var body: some View {
        let s = model.summary
        let c = s.counts
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                // Key counts grid
                VStack(alignment: .leading, spacing: 6) {
                    SectionTitle("SUMMARY")
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 6) {
                        MetricTile(label: "Labeled Frames", value: formatInt(c.labeled_frames))
                        MetricTile(
                            label: "Instances",
                            value: formatInt(c.instances),
                            sub: c.user_instances + c.predicted_instances > 0
                                ? "\(formatInt(c.user_instances))u · \(formatInt(c.predicted_instances))p"
                                : nil
                        )
                        MetricTile(label: "User Points", value: formatInt(c.user_points))
                        MetricTile(label: "Pred Points", value: formatInt(c.predicted_points))
                        MetricTile(label: "Tracks", value: formatInt(c.tracks))
                        MetricTile(
                            label: "Videos",
                            value: formatInt(c.videos),
                            sub: c.embedded_videos > 0 ? "\(c.embedded_videos) embedded" : "external"
                        )
                    }
                }

                // Extra annotations (only if present)
                let extras = extraAnnotationItems(c)
                if !extras.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle("ANNOTATIONS")
                        FlowPills(items: extras)
                    }
                }

                // Skeletons
                if !s.skeletons.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle("SKELETONS (\(s.skeletons.count))")
                        ForEach(s.skeletons) { skel in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text(skel.name)
                                        .font(.system(size: 11.5, weight: .semibold))
                                    Spacer()
                                    Text("\(skel.nodes.count)n · \(skel.edges.count)e")
                                        .font(.system(size: 10.5, design: .monospaced))
                                        .foregroundStyle(.secondary)
                                }
                                Text(skel.nodes.joined(separator: ", "))
                                    .font(.system(size: 10.5))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(3)
                            }
                            .padding(8)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                    }
                }

                // Videos
                if !s.videos.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        SectionTitle("VIDEOS (\(s.videos.count))")
                        ForEach(s.videos.prefix(8)) { vid in
                            VStack(alignment: .leading, spacing: 3) {
                                HStack(spacing: 4) {
                                    Image(systemName: vid.embedded ? "photo.stack.fill" : "film")
                                        .font(.system(size: 10))
                                        .foregroundStyle(vid.embedded ? .green : .secondary)
                                    Text(vid.display_name)
                                        .font(.system(size: 11, weight: .medium))
                                        .lineLimit(1)
                                        .truncationMode(.middle)
                                }
                                HStack(spacing: 6) {
                                    if let w = vid.width, let h = vid.height {
                                        Text("\(w)×\(h)")
                                    }
                                    if let fc = vid.frame_count, fc > 0 {
                                        Text("\(formatInt(Int(fc))) fr")
                                    }
                                    if vid.embedded {
                                        Text("(\(vid.embedded_frame_count) emb)")
                                            .foregroundStyle(.green)
                                    }
                                    if let fmt = vid.format {
                                        Text(fmt.uppercased())
                                    }
                                }
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundStyle(.secondary)
                            }
                            .padding(7)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .background(Color(nsColor: .controlBackgroundColor))
                            .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                        }
                        if s.videos.count > 8 {
                            Text("+ \(s.videos.count - 8) more videos")
                                .font(.system(size: 10.5))
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                // Provenance
                if !s.provenance_summary.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        SectionTitle("PROVENANCE")
                        ForEach(s.provenance_summary, id: \.self) { pair in
                            if pair.count == 2 {
                                HStack(alignment: .top) {
                                    Text(pair[0])
                                        .font(.system(size: 10.5, weight: .medium))
                                        .foregroundStyle(.secondary)
                                    Spacer()
                                    Text(pair[1])
                                        .font(.system(size: 10.5))
                                        .multilineTextAlignment(.trailing)
                                        .lineLimit(2)
                                }
                            }
                        }
                    }
                }
            }
            .padding(12)
        }
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private func extraAnnotationItems(_ c: CountsInfo) -> [(String, Int)] {
        let all: [(String, Int)] = [
            ("BBoxes", c.bboxes),
            ("Masks", c.masks),
            ("ROIs", c.rois),
            ("Label Imgs", c.label_images),
            ("Events", c.events),
            ("Suggestions", c.suggestions),
            ("3D Sessions", c.sessions),
            ("Identities", c.identities),
            ("Categories", c.categories),
            ("Negative", c.negative_frames),
        ]
        return all.filter { $0.1 > 0 }
    }
}

private struct SectionTitle: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .tracking(0.6)
            .foregroundStyle(.secondary)
    }
}

private struct MetricTile: View {
    let label: String
    let value: String
    var sub: String? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(value)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .monospacedDigit()
            Text(label)
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            if let sub = sub {
                Text(sub)
                    .font(.system(size: 9.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

private struct FlowPills: View {
    let items: [(String, Int)]

    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 82), spacing: 5)], alignment: .leading, spacing: 5) {
            ForEach(items, id: \.0) { item in
                HStack(spacing: 4) {
                    Text(item.0)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                    Text(formatInt(item.1))
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
                .background(Color(nsColor: .controlBackgroundColor))
                .clipShape(Capsule())
            }
        }
    }
}

// MARK: - Error View

struct SLPErrorView: View {
    let filename: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 28))
                .foregroundStyle(.orange)
            Text(filename)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Formatting helpers

private func formatInt(_ n: Int) -> String {
    let fmt = NumberFormatter()
    fmt.numberStyle = .decimal
    return fmt.string(from: NSNumber(value: n)) ?? "\(n)"
}

private func formatBytes(_ bytes: UInt64) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
}
