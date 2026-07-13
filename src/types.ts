export interface ArticleFrontmatter {
  title: string;
  description: string;
  date: string;
  author: string;
  series: string;
  order: number;
  faq: Array<{ question: string; answer: string }>;
  next?: { slug: string; title: string };
}

export interface Chunk {
  id?: number;
  articleTitle: string;
  articleUrl: string;
  articleOrder: number;
  sectionHeading: string;
  chunkType: "intro" | "section" | "faq";
  content: string;
}

export interface SearchResult {
  title: string;
  section: string;
  content: string;
  url: string;
  relevance_score: number;
}

export interface AnswerResult {
  answer: string;
  source_title: string;
  source_url: string;
  related_articles: Array<{ title: string; url: string }>;
  confidence_score: number;
}

// Query logging types
export interface QueryLogEntry {
  timestamp: string;
  clientId: string;
  toolName: string;
  queryParams: string;
  contentCited: string;
  responseTimeMs: number;
  confidenceScore: number | null;
}

export interface TopicEntry {
  title: string;
  description: string;
  url: string;
  content_type: string;
  topics: string[];
}

export interface TutorialResult {
  title: string;
  url: string;
  description: string;
  steps: string[];
  confidence_score: number;
}

export interface ComparisonResult {
  topic_a: { title: string; url: string; key_points: string[] };
  topic_b: { title: string; url: string; key_points: string[] };
  confidence_score: number;
}

export interface LatestArticle {
  title: string;
  description: string;
  url: string;
  content_type: string;
  added_at: string | null;
}

// Content structuring types
export type ContentType = "article" | "tutorial" | "faq" | "comparison" | "guide" | "newsletter" | "project" | "draft" | "concept" | "entity" | "synthesis";

export interface QaPair {
  question: string;
  answer: string;
}

export interface ClassificationResult {
  content_type: ContentType;
  title: string;
  description: string;
  topics: string[];
  author: string;
}

export interface StructuredArticle {
  url: string;
  sourceUrl: string;
  slug: string;
  title: string;
  description: string;
  author: string;
  contentType: ContentType;
  topics: string[];
  qaPairs: QaPair[];
  jsonLd: string;
  markdownBody: string;
  processedAt: string;
  pubDate?: string;
  // WHAT: Curated tags (from seo.md / frontmatter) stored as a queryable field.
  // WHY: Enables structured "find articles tagged X" search via find_articles.
  tags?: string[];
  sourceOrigin?: string;
}

export const EMBEDDING_DIM = 768;
export const BASE_URL = "https://astgl.ai/answers";

// Phase 5: Idea Journal types
export type IdeaSource = "manual" | "query-gap" | "low-confidence" | "trending" | "alert";
export type IdeaPriority = "high" | "medium" | "low";
export type IdeaStatus = "new" | "in-progress" | "published" | "rejected";

export interface Idea {
  id: number;
  title: string;
  description: string;
  source: IdeaSource;
  priority: IdeaPriority;
  status: IdeaStatus;
  created_at: string;
  updated_at: string;
  related_queries: string[];
  tags: string[];
}

export interface IdeaFilters {
  status?: IdeaStatus;
  priority?: IdeaPriority;
  source?: IdeaSource;
  limit?: number;
}

// Phase 5: Dashboard types
export interface DashboardData {
  generated_at: string;
  period_days: number;
  query_trends: {
    total: number;
    by_day: Array<{ date: string; count: number }>;
    by_tool: Record<string, number>;
    top_queries: Array<{ query: string; count: number }>;
    avg_confidence: number;
  };
  content_coverage: {
    total_articles: number;
    by_type: Record<string, number>;
    freshness_summary: Record<string, number>;
    recently_added: Array<{ title: string; url: string; date: string }>;
  };
  citation_tracking: {
    top_cited: Array<{ url: string; times_cited: number }>;
    uncited_count: number;
  };
  content_gaps: {
    low_confidence_queries: Array<{ query: string; confidence: number }>;
    idea_count_by_status: Record<string, number>;
  };
  ecosystem_status: Array<{
    package_name: string;
    current_version: string;
    check_type: string;
  }>;
}
