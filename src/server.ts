import {
  type AgentNamespace,
  routeAgentRequest,
  type Schedule,
  type Agent,
} from "agents";
import { AIChatAgent } from "agents/ai-chat-agent";
import {
  createDataStreamResponse,
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { processToolCalls } from "./utils";
import { tools, executions } from "./tools";
import { AsyncLocalStorage } from "node:async_hooks";
import type { D1Database, Ai } from "@cloudflare/workers-types";

// Environment variables type definition
export type Env = {
  OPENAI_API_KEY: string;
  Chat: AgentNamespace<Chat>;
  AI: Ai; // Cloudflare AI binding for podcast generation
  DB: D1Database; // D1 Database binding for podcast storage
};

// we use ALS to expose the agent context to the tools
export const agentContext = new AsyncLocalStorage<Chat>();

type Podcast = {
  topic: string; 
  slug: string;
  url: string;
  created_at: string;
}

export type ChatState = { podcasts:Podcast[], lastUpdated: Date | null };

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 * and podcast generation using Cloudflare Workers AI
 */
export class Chat extends AIChatAgent<Env, ChatState> {
  /**
   * Handles incoming chat messages and manages the response stream
   * @param onFinish - Callback function executed when streaming completes
   */
  initialState: ChatState = { podcasts: [], lastUpdated: null };

  // biome-ignore lint/complexity/noBannedTypes: <explanation>
  async onChatMessage(onFinish: StreamTextOnFinishCallback<{}>) {
    // Create a streaming response that handles both text and tool outputs
    return agentContext.run(this, async () => {
      const dataStreamResponse = createDataStreamResponse({
        execute: async (dataStream) => {
          // Process any pending tool calls from previous messages
          // This handles human-in-the-loop confirmations for tools
          const processedMessages = await processToolCalls({
            messages: this.messages,
            dataStream,
            tools,
            executions,
          });

          // Initialize OpenAI client with API key from environment
          const openai = createOpenAI({
            apiKey: this.env.OPENAI_API_KEY,
          });

          // Cloudflare AI Gateway
          // const openai = createOpenAI({
          //   apiKey: this.env.OPENAI_API_KEY,
          //   baseURL: this.env.GATEWAY_BASE_URL,
          // });

          // Stream the AI response using GPT-4
          const result = streamText({
            model: openai("gpt-4o-2024-11-20"),
            system: `
             You are a helpful podcast assistant that can generate podcasts and manage podcast content using Cloudflare Workers AI. You can:
              - Generate podcasts on any topic using the generatePodcast tool
              - List previously generated podcasts using the listRecentPodcasts tool
              - Schedule tasks to be executed later if needed
              
              When users ask for podcasts, use the available tools to create and manage podcast content. The time is now: ${new Date().toISOString()}.
              `,
            messages: processedMessages,
            tools,
            onFinish,
            maxSteps: 10,
          });

          // Merge the AI response stream with tool execution outputs
          result.mergeIntoDataStream(dataStream);
        },
      });

      return dataStreamResponse;
    });
  }

  async executeTask(description: string, task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        content: `scheduled message: ${description}`,
      },
    ]);
  }

  async generatePodcast(topic: string) {
    const baseUrl = "https://podcaster.lizziepika.workers.dev";
    
    const messages = [
      { role: "system", content: "You are a friendly assistant" },
      {
        role: "user",
        content: "Return only one realistic-looking podcast URL slug about " + topic + " and nothing else. Don't quote it",
      },
    ];
    
    const response:any = await this.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages });
    console.log(`response: ${response.response}`);
    let slug = response.response;
    const url = baseUrl + "/" + slug;
    
    console.log(`DB binding exists: ${!!this.env.DB}`);
    console.log(`DB binding type: ${typeof this.env.DB}`);
    console.log(`DB binding constructor: ${this.env.DB?.constructor?.name}`);
    
    try {
      // First, let's try to list tables to verify connection
      const tablesResult = await this.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table';").all();
      console.log(`Available tables:`, tablesResult);
      
      // Check if slug already exists and make it unique if needed
      const existingSlug = await this.env.DB.prepare("SELECT slug FROM podcasts WHERE slug = ?").bind(slug).first();
      if (existingSlug) {
        // Add timestamp to make it unique
        const timestamp = Date.now();
        slug = `${slug}-${timestamp}`;
        console.log(`Slug already exists, using unique slug: ${slug}`);
      }
      
      const finalUrl = baseUrl + "/" + slug;
      
      const stmt = this.env.DB.prepare(`
        INSERT INTO podcasts (topic, slug, url, created_at) 
        VALUES (?, ?, ?, datetime('now'))
      `);
      const insertResult = await stmt.bind(topic, slug, finalUrl).run();
      console.log(`Saved podcast slug: ${slug} for topic: ${topic}`);
      console.log(`Insert result:`, insertResult);
      
      return `Podcast page is now live at this URL: ${finalUrl} about ${topic}`;
    } catch (error) {
      console.error("Failed to save podcast slug:", error);
      console.error("Error details:", JSON.stringify(error, null, 2));
      
      // If it's a constraint error, still return the URL even if we couldn't save
      if (error instanceof Error && error.message?.includes('UNIQUE constraint')) {
        console.log(`Duplicate slug detected, returning URL anyway: ${url}`);
        return `Podcast page is now live at this URL: ${url} about ${topic}`;
      }
      
      // For other errors, continue without saving
      return `Podcast page is now live at this URL: ${url} about ${topic}`;
    }
  }

  async listRecentPodcasts(limit: number = 10) {
    console.log(`Attempting to list ${limit} recent podcasts`);
    console.log(`DB binding exists: ${!!this.env.DB}`);
    console.log(`DB binding type: ${typeof this.env.DB}`);
    
    try {
      // First, let's try to list tables to verify connection
      const tablesResult = await this.env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table';").all();
      console.log(`Available tables:`, tablesResult);
      
      const stmt = this.env.DB.prepare(`
        SELECT topic, slug, url, created_at 
        FROM podcasts 
        ORDER BY created_at DESC 
        LIMIT ?
      `);
      
      console.log(`Prepared statement created successfully`);
      
      const result = await stmt.bind(limit).all();
      console.log(`Query executed, result:`, result);
      
      const podcasts = result.results || [];
      console.log(`Found ${podcasts.length} podcasts`);
      
      if (podcasts.length === 0) {
        return "No podcasts have been generated yet.";
      }

      const podcastList = podcasts.map((p: any) => 
        `• ${p.topic} - ${p.url} (Generated: ${new Date(p.created_at).toLocaleString()})`
      ).join('\n');

      return `Recent Podcasts (${podcasts.length}):\n\n${podcastList}`;
    } catch (error) {
      console.error("Failed to retrieve podcasts:", error);
      console.error("Error details:", JSON.stringify(error, null, 2));
      return `Failed to retrieve podcast list from database. Error: ${error}`;
    }
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    
    // Handle check OpenAI key endpoint
    if (url.pathname === "/check-open-ai-key") {
      const hasKey = !!env.OPENAI_API_KEY;
      return new Response(JSON.stringify({ hasKey }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    // Handle CORS preflight requests
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 200,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (!env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
      return new Response("OPENAI_API_KEY is not set", { status: 500 });
    }
    
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;