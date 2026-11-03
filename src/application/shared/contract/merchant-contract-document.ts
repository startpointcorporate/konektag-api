import { deflateRawSync, inflateRawSync } from 'node:zlib';
import template from './merchant-contract-template.json';

// OOXML parts from the existing approved-layout model, bundled by Astro.
// Values come only from the stored merchant dossier. Missing values remain editable.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(data: Buffer) {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}
function xml(value: unknown): string {
  return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildMerchantContract(merchant: Record<string, any>): Buffer {
  // Activities are configured after KYB; never infer them from optional profiles.
  const activities = '';
  const values: Record<string, unknown> = {
    'contract.status': 'À COMPLÉTER ET À SIGNER', 'contract.template_version': template.version,
    'customer.customer_name': merchant.business_name,
    'customer.email_id': merchant.email || merchant.ownerProfile?.email,
    'customer.mobile_no': merchant.phone || merchant.ownerProfile?.phone,
    'terms.partner_representative': [merchant.ownerProfile?.firstName, merchant.ownerProfile?.lastName].filter(Boolean).join(' '),
    'address.address_line1': merchant.address, 'address.city': merchant.city,
    'address.country': merchant.country, 'merchant.id': merchant.id, 'merchant.user_id': merchant.user_id,
    'terms.activities_n3': activities,
    'terms.establishments_n2': [merchant.business_name, merchant.address, merchant.city, merchant.country].filter(Boolean).join(', '),
    'terms.settlement_method': merchant.kyb_settlement_rail,
    'terms.settlement_account_reference': merchant.kyb_settlement_account,
  };
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of template.entries) {
    let data = inflateRawSync(Buffer.from(entry.base64, 'base64'));
    if (entry.name.endsWith('.xml')) {
      data = Buffer.from(data.toString('utf8').replace(/\[\[([a-z_]+\.[A-Za-z_0-9]+)\]\]/g, (_, key: string) => {
        if (key.startsWith('offer.') || key.startsWith('consent.')) return ' ';
        const value = values[key];
        return xml(value === undefined || value === null || String(value).trim() === '' ? '____________________' : value);
      }));
    }
    const compressed = deflateRawSync(data), name = Buffer.from(entry.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6);
    header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12); header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);
    const index = Buffer.alloc(46);
    index.writeUInt32LE(0x02014b50); index.writeUInt16LE(20, 4); header.copy(index, 6, 4, 28);
    index.writeUInt32LE(offset, 42); central.push(index, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(template.entries.length, 8);
  end.writeUInt16LE(template.entries.length, 10); end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
