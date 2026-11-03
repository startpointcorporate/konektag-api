import { uiMessages as sharedUiMessages, normalizeLocale as normalizeUiLocale } from './i18n.ts';
import {auditPublicSeo} from './merchant-seo-audit.ts';
export const hasVisibilityText=(value:unknown):boolean=>typeof value==='string'&&value.trim().length>0;

/** Shared, non-blocking recommendations for the free merchant visibility journey. */
export const visibilityEssentials = [
  {key:'businessName',label:'nom',href:'#sec-info'},
  {key:'shortDescription',label:'description',href:'#sec-info'},
  {key:'city',label:'ville',href:'#sec-address'},
  {key:'country',label:'pays',href:'#sec-address'},
  {key:'address',label:'adresse',href:'#sec-address'},
  {key:'phone',label:'téléphone',href:'#sec-info'},
] as const;
export function missingVisibilityEssentials(profile:Record<string,any>):string[]{
  const missing:string[]=visibilityEssentials.filter(item=>!hasVisibilityText(profile[item.key])).map(item=>item.label);
  if(!hasVisibilityText(profile.coverImageUrl)&&!hasVisibilityText(profile.logoUrl))missing.push('photo');
  return missing;
}
export type SeoAdvice={code:string;message:string;href:string};
export function merchantSeoAdvice(profile:Record<string,any>,publicPage?:{siteUrl:string;canonicalPath:string},locale='fr'):SeoAdvice[]{
 const extraUi = sharedUiMessages[normalizeUiLocale(locale)].additional;
 const title=String(profile.seoTitle??'').trim(),description=String(profile.seoDescription??'').trim();
 const issues:SeoAdvice[]=[];
 if(!title)issues.push({code:'TITLE_MISSING',message:extraUi.seoAddTitle,href:'#sec-seo'});
 else if(title.length<25||title.length>65)issues.push({code:'TITLE_LENGTH',message:extraUi.seoTitleLength,href:'#sec-seo'});
 if(!description)issues.push({code:'DESCRIPTION_MISSING',message:extraUi.seoAddDescription,href:'#sec-seo'});
 else if(description.length<70||description.length>165)issues.push({code:'DESCRIPTION_LENGTH',message:extraUi.seoDescriptionLength,href:'#sec-seo'});
 if(title&&profile.businessName&&!title.toLocaleLowerCase().includes(String(profile.businessName).toLocaleLowerCase()))issues.push({code:'BUSINESS_NAME',message:extraUi.seoMentionName,href:'#sec-seo'});
 if(publicPage)issues.push(...auditPublicSeo({...publicPage,canonicalOverride:profile.seoCanonicalUrl,structuredData:{'@context':'https://schema.org','@type':'LocalBusiness',name:profile.businessName}},locale).map(issue=>({...issue,href:'#sec-seo'})));
 return issues;
}
