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
}

export interface TopicEntry {
  title: string;
  description: string;
  url: string;
  topics: string[];
}

export const EMBEDDING_DIM = 768;
export const BASE_URL = "https://astgl.ai/answers";
