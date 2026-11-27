import Cocoa
import QuickLookUI
import SwiftUI

@objc(SLEAPPreviewViewController)
public final class PreviewViewController: NSViewController, QLPreviewingController {
    private var hostingView: NSView?
    private var activeModel: SLPPreviewModel?

    public override func loadView() {
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 920, height: 600))
        root.wantsLayer = true
        self.view = root
        self.preferredContentSize = NSSize(width: 920, height: 600)
    }

    public func preparePreviewOfFile(at url: URL, completionHandler handler: @escaping (Error?) -> Void) {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                let box = try SLPHandleBox(url: url)
                let model = SLPPreviewModel(box: box)
                DispatchQueue.main.async {
                    guard let self = self else {
                        handler(nil)
                        return
                    }
                    self.activeModel = model
                    self.installSwiftUIView(SLPPreviewView(model: model))
                    handler(nil)
                }
            } catch {
                let message = error.localizedDescription
                let fname = url.lastPathComponent
                DispatchQueue.main.async {
                    guard let self = self else {
                        handler(nil)
                        return
                    }
                    self.activeModel = nil
                    self.installSwiftUIView(SLPErrorView(filename: fname, message: message))
                    handler(nil)
                }
            }
        }
    }

    private func installSwiftUIView<V: View>(_ rootView: V) {
        hostingView?.removeFromSuperview()
        let host = NSHostingView(rootView: rootView)
        host.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.topAnchor.constraint(equalTo: view.topAnchor),
            host.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        self.hostingView = host
    }
}
