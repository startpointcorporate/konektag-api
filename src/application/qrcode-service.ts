import QRCode from 'qrcode';

export class QrCodeService {
  async generateQrCodeBuffer(url: string): Promise<Buffer> {
    const buffer = await QRCode.toBuffer(url, {
      type: 'png',
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
    return buffer;
  }

  async generateQrCodeDataUrl(url: string): Promise<string> {
    return QRCode.toDataURL(url, {
      width: 400,
      margin: 2,
      color: { dark: '#000000', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  }

  async generateQrCodeSvg(url: string): Promise<string> {
    return QRCode.toString(url, {
      type: 'svg',
      width: 400,
      margin: 2,
      color: { dark: '#000', light: '#fff' },
      errorCorrectionLevel: 'M',
    });
  }
}

export const qrcodeService = new QrCodeService();
