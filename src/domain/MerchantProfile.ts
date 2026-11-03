import type { Offer } from './core-business.ts';

export type ActivityCode = 'Restaurant' | 'Hotel' | 'Commerce';

/** @deprecated Use ActivityCode. */
export type ActivityType = ActivityCode;

export type ProfileStatus = 'Draft' | 'Published' | 'Suspended' | 'Referenced';

export type CertificationStatus = 'NON_CERTIFIED' | 'PENDING_VALIDATION' | 'VALIDATED';

export type CertificationDocumentType = 'business_document' | 'manager_identity' | 'establishment_photo';

export type MediaType = 'Image' | 'Pdf' | 'Audio' | 'Video';

export type LinkType = 'Website' | 'Instagram' | 'Facebook' | 'TikTok' | 'YouTube' | 'LinkedIn' | 'Pinterest' | 'X' | 'Threads' | 'Snapchat' | 'WhatsApp' | 'Telegram' | 'Booking' | 'Menu' | 'Catalog' | 'Other';

export type PriceRange = 'Low' | 'Medium' | 'High' | 'Premium';

export type MenuType = 'DigitalMenu' | 'PdfMenu' | 'ImageMenu' | 'SingleDish' | 'DailyMenu';

export type MainActivity = 'Alimentation' | 'Mode' | 'Beauté' | 'Électronique' | 'Services' | 'Artisanat' | 'Santé' | 'Autre';

export interface MerchantMedia {
  id: string;
  merchantProfileId: string;
  mediaType: MediaType;
  title?: string;
  description?: string;
  fileUrl: string;
  thumbnailUrl?: string;
  displayOrder: number;
  createdAt: string;
}

export interface MerchantExternalLink {
  id: string;
  merchantProfileId: string;
  label: string;
  url: string;
  linkType: LinkType;
  displayOrder?: number;
}

export interface MerchantOpeningHour {
  id: string;
  merchantProfileId: string;
  activityCode?: ActivityCode | null;
  dayOfWeek: number;
  openTime?: string;
  closeTime?: string;
  isClosed: boolean;
  breakStartTime?: string;
  breakEndTime?: string;
  openTime2?: string;
  closeTime2?: string;
}

export interface RestaurantProfile {
  merchantProfileId: string;
  shortDescription?: string;
  longDescription?: string;
  phone?: string;
  email?: string;
  status: ProfileStatus;
  featured: boolean;
  featuredAt?: string;
  priceRange?: PriceRange;
  cuisineTypes: string[];
  offerType?: 'AlaCarte' | 'DailyMenu' | 'SingleDish' | 'Other';
  menuMedium?: 'Konektag' | 'Pdf' | 'Image' | 'External' | 'Board' | 'None';
  menuExternalUrl?: string;
  menuMediaId?: string;
  specialties?: string;
  averageMealPrice?: number;
  hasDelivery: boolean;
  hasTakeAway: boolean;
  hasDineIn: boolean;
  hasReservation: boolean;
}

export interface HotelProfile {
  merchantProfileId: string;
  shortDescription?: string;
  longDescription?: string;
  phone?: string;
  email?: string;
  status: ProfileStatus;
  featured: boolean;
  featuredAt?: string;
  priceRange?: PriceRange;
  stars?: number;
  roomPriceMin?: number;
  roomPriceMax?: number;
  amenities: string[];
  checkInTime?: string;
  checkOutTime?: string;
  hasOnlineBooking: boolean;
  hasDelivery: boolean;
  hasTakeout: boolean;
  hasDineIn: boolean;
}

export interface CommerceProfile {
  merchantProfileId: string;
  shortDescription?: string;
  longDescription?: string;
  phone?: string;
  email?: string;
  status: ProfileStatus;
  featured: boolean;
  featuredAt?: string;
  mainActivity?: MainActivity;
  priceRange?: PriceRange;
  productsServices?: string;
  hasCatalog: boolean;
  hasDelivery: boolean;
  hasTakeout: boolean;
  hasDineIn: boolean;
}

export interface MerchantProduct extends Pick<Offer, 'id' | 'merchantProfileId' | 'name'> {
  description?: string;
  price?: number;
  currency: string;
  imageUrl?: string;
  offerCategoryId: string;
  offerSubcategoryId?: string;
  displayOrder?: number;
  pricingRuleId?: string;
  catalogMetadata?: import('./public-catalog.ts').CatalogMetadata;
}

export interface CertificationDocument {
  id: string;
  merchantProfileId: string;
  documentType: CertificationDocumentType;
  title?: string;
  fileUrl: string;
  fileKey?: string;
  mimeType?: string;
  submittedAt: string;
  createdAt: string;
}

export interface CertificationDossier {
  status: CertificationStatus;
  submittedAt?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  documents: CertificationDocument[];
  receivedTransactions: number;
  receivedTransactionsRequired: number;
}

export interface MerchantProfile {
  id: string;
  userId?: string;
  businessName: string;
  slug: string;
  logoUrl?: string;
  coverImageUrl?: string;
  shortDescription?: string;
  longDescription?: string;
  address?: string;
  city?: string;
  country?: string;
  neighborhood?: string;
  phone?: string;
  email?: string;
  websiteUrl?: string;
  seoTitle?: string;
  seoDescription?: string;
  seoCanonicalUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageUrl?: string;
  latitude?: number;
  longitude?: number;
  distanceKm?: number;
  externalLinks?: MerchantExternalLink[];
  openingHours?: MerchantOpeningHour[];
  status: ProfileStatus;
  certificationStatus: CertificationStatus;
  certificationSubmittedAt?: string;
  certificationReviewedAt?: string;
  certificationReviewedBy?: string;
  qrCodeUrl?: string;
  qrCodeDataUrl?: string;
  publicPageUrl?: string;
  source?: string;
  sourceId?: string;
  sourceUrl?: string;
  referencedAt?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
  media?: MerchantMedia[];
  restaurantProfile?: RestaurantProfile;
  hotelProfile?: HotelProfile;
  commerceProfile?: CommerceProfile;
  products?: MerchantProduct[];
  certificationDocuments?: CertificationDocument[];
  receivedTransactions?: number;
  matchContext?: {
    source: 'merchant' | 'offer';
    offer?: {
      id: string;
      name: string;
      type?: 'product' | 'service';
      category?: string;
      subcategory?: string;
      shortDescription?: string;
      price?: number;
      currency?: string;
      imageUrl?: string;
    };
    additionalMatches?: number;
  };
}

export interface CreateMerchantProfileInput {
  businessName: string;
  shortDescription?: string;
  longDescription?: string;
  address?: string;
  /** Required: a merchant always has a country and a city (see MerchantLocation). */
  city: string;
  country: string;
  phone?: string;
  email?: string;
  websiteUrl?: string;
}

export interface UpdateMerchantProfileInput {
  businessName?: string;
  logoUrl?: string | null;
  coverImageUrl?: string | null;
  shortDescription?: string | null;
  longDescription?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  neighborhood?: string | null;
  phone?: string | null;
  email?: string | null;
  websiteUrl?: string | null;
  seoTitle?: string | null;
  seoDescription?: string | null;
  seoCanonicalUrl?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImageUrl?: string | null;
  latitude?: number;
  longitude?: number;
}

export interface MerchantSearchFilters {
  cityId?: string;
  activityCode?: ActivityCode;
  city?: string;
  country?: string;
  openNow?: boolean;
  priceRange?: PriceRange;
  query?: string;
  offerType?: 'product' | 'service';
  offerCategoryId?: string;
  offerSubcategoryId?: string;
  cuisineTypes?: string[];
  stars?: number;
  mainActivity?: MainActivity;
  hasDelivery?: boolean;
  hasTakeAway?: boolean;
  hasDineIn?: boolean;
  hasReservation?: boolean;
  hasMenu?: boolean;
  menuType?: MenuType;
  hasOnlineBooking?: boolean;
  hasCatalog?: boolean;
  amenities?: string[];
  lat?: number;
  lng?: number;
  radiusKm?: number;
  minDistanceKm?: number;
  certified?: boolean;
  page?: number;
  limit?: number;
}

export interface MarketplaceMatchContext {
  source: 'merchant' | 'n3' | 'offer';
  offer?: {
    id: string;
    name: string;
    type?: 'product' | 'service';
    categoryId: string;
    categoryCode?: string;
    categoryNameI18n?: Record<string,string>;
    subcategoryId?: string;
    subcategoryCode?: string;
    subcategoryNameI18n?: Record<string,string>;
    shortDescription?: string;
    price?: number;
    currency?: string;
    imageUrl?: string;
  };
  additionalMatches?: number;
}

export interface MarketplaceSearchItem {
  merchantProfileId: string;
  activityCode?: ActivityCode;
  availableActivities: ActivityCode[];
  businessName: string;
  slug: string;
  logoUrl?: string;
  coverImageUrl?: string;
  shortDescription?: string;
  longDescription?: string;
  address?: string;
  neighborhood?: string;
  phone?: string;
  email?: string;
  websiteUrl?: string;
  priceRange?: PriceRange;
  cuisineTypes?: string[];
  specialties?: string;
  averageMealPrice?: number;
  hasMenu?: boolean;
  hasReservation?: boolean;
  city?: string;
  country?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  certificationStatus: CertificationStatus;
  merchantStatus?: ProfileStatus;
  hasPro?: boolean;
  featured?: boolean;
  associated: boolean;
  hasDelivery?: boolean;
  hasTakeout?: boolean;
  hasDineIn?: boolean;
  distanceKm?: number;
  openNow?: boolean;
  matchContext?: MarketplaceMatchContext;
}

export interface MerchantSearchResult {
  results: MarketplaceSearchItem[];
  total: number;
  page: number;
  limit: number;
}

export interface SubmitCertificationInput {
  merchantProfileId?: string;
}

export interface SubmitCertificationDocumentInput {
  documentType: CertificationDocumentType;
  title?: string;
  fileBuffer: Buffer;
  originalName: string;
  mimeType: string;
}

