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
export type ContentType = "article" | "tutorial" | "faq" | "comparison" | "guide" | "newsletter" | "project";

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
}

export const EMBEDDING_DIM = 768;
export const BASE_URL = "https://astgl.ai/answers";
