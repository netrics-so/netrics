import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins

public enum QRCode {
    /**
     * A QR code (CIQRCodeGenerator, error correction M) scaled up without
     * smoothing, so the modules stay crisp at TV size.
     */
    public static func image(for text: String, scale: CGFloat = 12) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext(options: [.useSoftwareRenderer: false]).createCGImage(scaled, from: scaled.extent)
    }
}
