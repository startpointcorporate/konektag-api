// Header validation supplements the storage layer; MIME and filename alone are untrusted.
export function validateMerchantMedia(bytes:Uint8Array,mime:string,name:string) {
 if(!bytes.length||bytes.length>50*1024*1024)throw new Error('INVALID_MEDIA_SIZE');
 const b=Buffer.from(bytes),ext=name.toLowerCase().split('.').pop();
 const signatures:Record<string,{extensions:string[];valid:boolean}>={
 'image/jpeg':{extensions:['jpg','jpeg'],valid:b[0]===255&&b[1]===216&&b[2]===255},
 'image/png':{extensions:['png'],valid:b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))},
 'image/gif':{extensions:['gif'],valid:['GIF87a','GIF89a'].includes(b.toString('ascii',0,6))},
 'image/webp':{extensions:['webp'],valid:b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WEBP'},
 'video/mp4':{extensions:['mp4'],valid:b.length>=12&&b.toString('ascii',4,8)==='ftyp'},
 'video/webm':{extensions:['webm'],valid:b.subarray(0,4).equals(Buffer.from([26,69,223,163]))},
 'application/pdf':{extensions:['pdf'],valid:b.toString('ascii',0,5)==='%PDF-'},
 'audio/mpeg':{extensions:['mp3'],valid:b.toString('ascii',0,3)==='ID3'||(b[0]===255&&(b[1]&224)===224)},
 'audio/wav':{extensions:['wav'],valid:b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='WAVE'},
 };
 if(!signatures[mime]?.valid||!signatures[mime].extensions.includes(ext||''))throw new Error('INVALID_MEDIA_FORMAT');
}
