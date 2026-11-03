import { uiMessages as sharedUiMessages, normalizeLocale as normalizeUiLocale } from './i18n.ts';
/** Advisory checks only: never used as publication gates. */
export type SeoIssue={code:string;message:string};
export function auditPublicSeo(input:{siteUrl:string;canonicalPath:string;canonicalOverride?:string|null;structuredData?:Record<string,unknown>;availableLocales?:string[]},locale='fr'):SeoIssue[]{
 const extraUi = sharedUiMessages[normalizeUiLocale(locale)].additional;
 const issues:SeoIssue[]=[];
 const {siteUrl,canonicalPath,canonicalOverride,structuredData}=input;
 let expected:URL;
 try{expected=new URL(canonicalPath,new URL(siteUrl.endsWith('/')?siteUrl:siteUrl+'/'));if(expected.origin!==new URL(siteUrl).origin||expected.username||expected.password||expected.search||expected.hash)return [{code:'INVALID_CANONICAL_PATH',message:extraUi.seoCheckPath}];if(expected.protocol!=='https:')issues.push({code:'SITE_NOT_HTTPS',message:extraUi.seoHttps});}
 catch{return [{code:'INVALID_CANONICAL_PATH',message:extraUi.seoCheckPath}];}
 if(canonicalOverride){
  try{const actual=new URL(canonicalOverride);if(actual.origin!==expected.origin||actual.pathname!==expected.pathname||actual.search||actual.hash||actual.username||actual.password)issues.push({code:'CANONICAL_MISMATCH',message:extraUi.seoCanonicalOfficial});}
  catch{issues.push({code:'CANONICAL_INVALID',message:extraUi.seoCanonicalInvalid});}
 }
 if(!structuredData)issues.push({code:'STRUCTURED_DATA_MISSING',message:extraUi.seoStructuredMissing});
 else{
  if(structuredData['@context']!=='https://schema.org'||!structuredData['@type']||!structuredData.name)issues.push({code:'STRUCTURED_DATA_INCOMPLETE',message:extraUi.seoStructuredDetails});
  if(structuredData.url&&String(structuredData.url)!==expected.href)issues.push({code:'STRUCTURED_URL_MISMATCH',message:extraUi.seoStructuredUrl});
 }
 return issues;
}
