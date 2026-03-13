export type IntelBriefingCategory = 'conflict' | 'news' | 'humanitarian';

export type IntelSeverity = 'high' | 'medium' | 'low';

export interface IntelBriefingItem {
  id: string;
  source: 'acled' | 'gdelt' | 'reliefweb' | 'newsapi';
  category: IntelBriefingCategory;
  severity: IntelSeverity;
  title: string;
  summary: string;
  url: string | null;
  publishedAt: string;
  locationLabel: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface IntelSourceStatus {
  configured: boolean;
  ok: boolean;
  itemCount: number;
  error: string | null;
}

export interface IntelBriefingResponse {
  items: IntelBriefingItem[];
  sources: Record<string, IntelSourceStatus>;
}
