// Live agent endpoints, all behind the vault agent's bearer token:
//   POST /v1/chat/completions  OpenAI-compatible hosted model for the local vault agent (fixed Qwen, daily cap)
//   POST /v1/corpus/search     semantic search over the Vectorize corpus
//   POST /v1/corpus/upsert     add or replace corpus chunks (embedded here, never on the caller)
//   POST /v1/corpus/delete     remove chunks by id
import { InputError, MODEL, checkCredentials } from "./protocol.mjs";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const MAX_CHUNK_CHARS = 2000;
const SOURCES = ["vault", "corpus", "repo"];
const ID = /^[a-f0-9]{64}$/;

const object = (value, keys) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    throw new InputError(`Send only ${keys.join(", ")}.`);
  }
  return value;
};
const text = (value, name, max) => {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) {
    throw new InputError(`${name} must be 1-${max} characters.`);
  }
  return value;
};

export function chatRequest(body) {
  const value = object(body, ["model", "messages", "max_tokens", "temperature", "response_format", "stream"]);
  if (value.stream) throw new InputError("Streaming is not supported.");
  if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 40) {
    throw new InputError("Send 1-40 messages.");
  }
  const messages = value.messages.map(message => {
    object(message, ["role", "content"]);
    if (!["system", "user", "assistant"].includes(message.role)) throw new InputError("Unknown message role.");
    return { role: message.role, content: text(message.content, "Message content", 60000) };
  });
  const maxTokens = Math.min(Math.max(Number.parseInt(value.max_tokens ?? 2000, 10) || 2000, 1), 2000);
  const temperature = Math.min(Math.max(Number(value.temperature ?? 0.2) || 0, 0), 1);
  const json = value.response_format?.type === "json_object";
  return { messages, maxTokens, temperature, json };
}

export async function chat(env, body) {
  const request = chatRequest(body);
  if (!await env.BUDGET.getByName("agent-chat-budget").reserve(dailyLimit(env.AGENT_DAILY_LIMIT, 1000))) {
    return { status: 429, body: { error: "Hosted agent reached its UTC daily call cap." } };
  }
  const messages = request.messages.map((message, index) => index === request.messages.length - 1 && message.role === "user"
    ? { ...message, content: `${message.content}\n/no_think` } : message);
  const raw = await env.AI.run(MODEL, {
    messages, max_tokens: request.maxTokens, temperature: request.temperature, stream: false,
    ...(request.json ? { response_format: { type: "json_object" } } : {}),
  });
  let content = raw?.choices?.[0]?.message?.content ?? raw?.response;
  if (content && typeof content === "object") content = JSON.stringify(content);
  if (typeof content !== "string" || !content.trim()) throw new Error("Model returned no answer.");
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return { status: 200, body: { model: MODEL, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: raw?.choices?.[0]?.finish_reason ?? "stop" }] } };
}

export function dailyLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function embed(env, texts) {
  const result = await env.AI.run(EMBEDDING_MODEL, { text: texts });
  if (!Array.isArray(result?.data) || result.data.length !== texts.length) throw new Error("Embedding model returned no vectors.");
  return result.data;
}

export async function search(env, body) {
  const value = object(body, ["query", "topK", "source"]);
  const query = text(value.query, "query", 2000);
  const topK = Math.min(Math.max(Number.parseInt(value.topK ?? 5, 10) || 5, 1), 10);
  if (value.source !== undefined && !SOURCES.includes(value.source)) throw new InputError(`source must be one of ${SOURCES.join(", ")}.`);
  if (!await env.BUDGET.getByName("corpus-search-budget").reserve(dailyLimit(env.CORPUS_SEARCH_DAILY_LIMIT, 3000))) {
    return { status: 429, body: { error: "Corpus search reached its UTC daily cap." } };
  }
  const [vector] = await embed(env, [query]);
  const found = await env.CORPUS.query(vector, {
    topK, returnMetadata: "all", ...(value.source ? { filter: { source: value.source } } : {}),
  });
  return { status: 200, body: { matches: (found.matches ?? []).map(match => ({
    id: match.id, score: Math.round(match.score * 1000) / 1000, source: match.metadata?.source, path: match.metadata?.path,
    title: match.metadata?.title, url: match.metadata?.url, text: match.metadata?.text,
  })) } };
}

export function chunkInput(value) {
  object(value, ["id", "source", "path", "title", "url", "text"]);
  if (!ID.test(value.id)) throw new InputError("Chunk id must be 64 lowercase hex characters.");
  if (!SOURCES.includes(value.source)) throw new InputError(`source must be one of ${SOURCES.join(", ")}.`);
  const chunk = { id: value.id, source: value.source, path: text(value.path, "path", 300), text: text(value.text, "text", MAX_CHUNK_CHARS) };
  if (value.title !== undefined) chunk.title = text(value.title, "title", 300);
  if (value.url !== undefined) {
    const url = new URL(text(value.url, "url", 500));
    if (url.protocol !== "https:" || url.username || url.password) throw new InputError("url must be a credential-free https URL.");
    chunk.url = url.href;
  }
  checkCredentials(chunk.text);
  return chunk;
}

export async function upsert(env, body) {
  const value = object(body, ["chunks"]);
  if (!Array.isArray(value.chunks) || !value.chunks.length || value.chunks.length > 25) throw new InputError("Send 1-25 chunks.");
  const chunks = value.chunks.map(chunkInput);
  if (new Set(chunks.map(chunk => chunk.id)).size !== chunks.length) throw new InputError("Duplicate chunk id.");
  if (!await env.BUDGET.getByName("corpus-upsert-budget").reserve(dailyLimit(env.CORPUS_UPSERT_DAILY_LIMIT, 2000))) {
    return { status: 429, body: { error: "Corpus indexing reached its UTC daily request cap." } };
  }
  const vectors = await embed(env, chunks.map(chunk => [chunk.title, chunk.text].filter(Boolean).join("\n")));
  await env.CORPUS.upsert(chunks.map((chunk, index) => {
    const { id, ...metadata } = chunk;
    return { id, values: vectors[index], metadata };
  }));
  return { status: 200, body: { upserted: chunks.length } };
}

export async function remove(env, body) {
  const value = object(body, ["ids"]);
  if (!Array.isArray(value.ids) || !value.ids.length || value.ids.length > 100 || value.ids.some(id => !ID.test(id))) {
    throw new InputError("Send 1-100 chunk ids.");
  }
  await env.CORPUS.deleteByIds(value.ids);
  return { status: 200, body: { deleted: value.ids.length } };
}
