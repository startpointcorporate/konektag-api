import { uiMessages as sharedUiMessages, normalizeLocale as normalizeUiLocale } from './i18n.ts';
import {merchantSeoAdvice,missingVisibilityEssentials,hasVisibilityText} from './merchant-visibility-criteria.ts';
import type { MerchantProfile } from '../../domain/MerchantProfile.ts';

export type VisibilityItem={code:string;label:string;points:number;earned:number;href:string;done:boolean};
export type VisibilityScore={score:number;level:string;items:VisibilityItem[];remaining:number;seoAdvice:ReturnType<typeof merchantSeoAdvice>};

export function assessMerchantVisibility(profile:MerchantProfile|null,publicPage?:{siteUrl:string;canonicalPath:string},locale='fr'):VisibilityScore{
 const extraUi = sharedUiMessages[normalizeUiLocale(locale)].additional;
  const p:Partial<MerchantProfile>=profile??{};
  const media=p.media??[], links=p.externalLinks??[], hours=p.openingHours??[];
  const missing=new Set(missingVisibilityEssentials(p));
  const has=(...labels:string[])=>labels.every(label=>!missing.has(label));
  const social=links.filter(l=>['Instagram','Facebook','TikTok','YouTube','LinkedIn','X','Pinterest','Threads','Snapchat'].includes(String(l.linkType)));
  const validMedia=media.some(m=>m.mediaType==='Image'&&hasVisibilityText(m.fileUrl));
  const validHours=hours.some(h=>Number.isInteger(h.dayOfWeek)&&h.dayOfWeek>=0&&h.dayOfWeek<=6);
  const raw=[
    ['identity',extraUi.visibilityIdentity,15,has('nom','téléphone','ville','pays'),'#sec-info'],
    ['description',extraUi.visibilityDescription,10,has('description')&&hasVisibilityText(p.longDescription),'#sec-info'],
    ['location',extraUi.visibilityLocation,10,has('adresse','ville','pays'),'#sec-address'],
    ['media',extraUi.visibilityPhotos,15,hasVisibilityText(p.coverImageUrl)||hasVisibilityText(p.logoUrl)||validMedia,'#sec-photos'],
    ['hours',extraUi.visibilityHours,10,validHours,'#sec-hours'],
    ['seo',extraUi.visibilitySeo,15,hasVisibilityText(p.seoTitle)&&hasVisibilityText(p.seoDescription),'#sec-seo'],
    ['social',extraUi.visibilitySocial,10,social.length>0,'#sec-social'],
    ['links',extraUi.visibilityLinks,5,links.length>0,'#sec-links'],
    ['activity',extraUi.visibilityPublished,10,[p.restaurantProfile,p.hotelProfile,p.commerceProfile].some(a=>a&&['Published','Referenced'].includes(a.status)),'#sec-activities'],
  ] as const;
  const items:VisibilityItem[]=raw.map(([code,label,points,done,href])=>({code,label,points,earned:done?points:0,done,href}));
  const score=items.reduce((s,i)=>s+i.earned,0);
  const level=score>=90?extraUi.visibilityExcellent:score>=75?extraUi.visibilityGood:score>=50?extraUi.visibilityFair:extraUi.visibilityIncomplete;
  return {score,level,items,remaining:100-score,seoAdvice:merchantSeoAdvice(p,publicPage,locale)};
}
