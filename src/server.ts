import {
  type AgentNamespace,
  routeAgentRequest,
  type Schedule,
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
  script?: string;
  audio_data?: string;
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

          // Stream the AI response using GPT-4
          const result = streamText({
            model: openai("gpt-4o-2024-11-20"),
            system: `
             You are a helpful podcast assistant that can generate podcasts and manage podcast content using Cloudflare Workers AI. You can:
              - Generate podcasts on any topic using the generatePodcast tool
              - Create audio podcasts with MP3 files using the createAudioPodcast tool
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
    
    try {
      // Check if slug already exists and make it unique if needed
      const existingSlug = await this.env.DB.prepare("SELECT slug FROM podcasts WHERE slug = ?").bind(slug).first();
      if (existingSlug) {
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
      
      return `Podcast page is now live at this URL: ${finalUrl} about ${topic}`;
    } catch (error) {
      console.error("Failed to save podcast slug:", error);
      
      // For errors, continue without saving
      const messages = [
        { role: "system", content: "You are a friendly assistant" },
        {
          role: "user",
          content: `Return a message about the podcast that was just generated about ${topic} at ${url} and nothing else. `,
        },
      ];
      
      const responseMsg:any = await this.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages });
      return responseMsg.response;
    }
  }

  /**
   * Creates an audio podcast with MP3 generation and saves to database
   * @param topic - The topic for the podcast
   * @param accessibilityMode - "accessible" for full transcript, otherwise standard
   */
  async createAudioPodcast(topic: string, accessibilityMode: string = "standard") {
    console.log(`Creating audio podcast for topic: ${topic} with mode: ${accessibilityMode}`);

    const isAccessible = accessibilityMode.toLowerCase() === "accessible";
    const baseUrl = "https://podcaster.lizziepika.workers.dev";

    try {
      // Step 1: Generate podcast script using AI
      const scriptMessages = [
        {
          role: "system",
          content: isAccessible
            ? `You are a professional podcast script writer specializing in accessible content. Create engaging, well-structured podcast scripts that are perfect for both audio listening and text reading.`
            : `You are a professional podcast script writer. Create engaging, conversational podcast scripts that sound natural when spoken aloud. Keep scripts concise but informative, typically 2-3 minutes when read aloud (about 300-450 words).`,
        },
        {
          role: "user",
          content: isAccessible
            ? `Write a comprehensive podcast script about "${topic}" with clear sections, natural speech patterns, and approximately 4-5 minutes when read aloud (600-750 words). Include an introduction, main points, and conclusion.`
            : `Write a brief podcast script about "${topic}" that covers 2-3 key points, uses conversational language, and can be read aloud in 2-3 minutes (300-450 words). Return only the script text.`,
        },
      ];

      console.log("Generating podcast script...");
      const scriptResponse: any = await this.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: scriptMessages,
      });

      if (!scriptResponse.response) {
        throw new Error("Failed to generate podcast script");
      }

      const fullScript = scriptResponse.response;
      console.log(`Generated script: ${fullScript.substring(0, 100)}...`);

      // Clean script for audio (remove any section markers)
      const audioScript = fullScript.replace(/\[.*?\]/g, "").replace(/\n\n+/g, "\n\n").trim();

      // Step 2: Convert script to audio
      console.log("Converting script to audio...");
      let audioDataUrl = "";
      let audioError = null;

      try {
        const audioResponse: any = await this.env.AI.run("@cf/myshell-ai/melotts", {
          prompt: audioScript,
          lang: "en",
        });

        if (audioResponse?.audio) {
          audioDataUrl = `data:audio/mp3;base64,${audioResponse.audio}`;
          console.log("Audio generated successfully");
        } else {
          throw new Error("No audio data returned");
        }
      } catch (error) {
        console.warn("Audio generation failed:", error);
        audioError = error;
      }

      // Step 3: Generate unique slug
      const slugMessages = [
        { role: "system", content: "You are a helpful assistant that creates URL-friendly slugs." },
        {
          role: "user",
          content: `Create a URL-friendly slug for a podcast about "${topic}". Return only the slug with hyphens, no quotes, no extra text.`,
        },
      ];

      const slugResponse: any = await this.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages: slugMessages,
      });

      let slug = slugResponse.response?.trim() || topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      
      // Add prefix and ensure uniqueness
      slug = `audio-${slug}`;
      
      try {
        const existingSlug = await this.env.DB.prepare("SELECT slug FROM podcasts WHERE slug = ?").bind(slug).first();
        if (existingSlug) {
          const timestamp = Date.now();
          slug = `${slug}-${timestamp}`;
        }
      } catch (e) {
        console.warn("Could not check for existing slug:", e);
      }

      const finalUrl = `${baseUrl}/${slug}`;

      // Step 4: Save to database with audio data
      try {
        // Try to add columns if they don't exist (migration)
        try {
          await this.env.DB.prepare("ALTER TABLE podcasts ADD COLUMN script TEXT").run();
          await this.env.DB.prepare("ALTER TABLE podcasts ADD COLUMN audio_data TEXT").run();
        } catch (e) {
          // Columns might already exist
        }

        const stmt = this.env.DB.prepare(`
          INSERT INTO podcasts (topic, slug, url, script, audio_data, created_at) 
          VALUES (?, ?, ?, ?, ?, datetime('now'))
        `);
        
        await stmt.bind(
          `${isAccessible ? "Accessible" : "Audio"}: ${topic}`, 
          slug, 
          finalUrl, 
          fullScript,
          audioDataUrl || null
        ).run();

        console.log(`Saved audio podcast record for topic: ${topic} with slug: ${slug}`);
      } catch (dbError) {
        console.warn("Could not save to database with audio data, trying basic save:", dbError);
        
        // Fallback: try basic insert
        try {
          const fallbackStmt = this.env.DB.prepare(`
            INSERT INTO podcasts (topic, slug, url, created_at) 
            VALUES (?, ?, ?, datetime('now'))
          `);
          await fallbackStmt.bind(`Audio: ${topic}`, slug, finalUrl).run();
        } catch (e) {
          console.warn("Basic save also failed:", e);
        }
      }

      // Step 5: Return success response
      const successMessage = audioDataUrl 
        ? `🎧 Audio podcast created successfully for "${topic}"! The podcast includes both script and MP3 audio.`
        : `📝 Podcast script created for "${topic}", but audio generation failed. You can still visit the page to see the content.`;

      return `${successMessage}\n\n🔗 Visit your podcast: ${finalUrl}\n\n${audioDataUrl ? '🎵 Includes playable MP3 audio' : '📄 Text-only version available'}`;

    } catch (error) {
      console.error("Failed to create audio podcast:", error);

      // Generate fallback response
      const fallbackSlug = `audio-${topic.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-fallback-${Date.now()}`;
      const fallbackUrl = `${baseUrl}/${fallbackSlug}`;

      return `⚠️ Audio podcast generation encountered issues for "${topic}", but a placeholder page was created at: ${fallbackUrl}`;
    }
  }

  async listRecentPodcasts(limit: number = 10) {
    console.log(`Attempting to list ${limit} recent podcasts`);
    
    try {
      const stmt = this.env.DB.prepare(`
        SELECT topic, slug, url, created_at 
        FROM podcasts 
        ORDER BY created_at DESC 
        LIMIT ?
      `);
      
      const result = await stmt.bind(limit).all();
      const podcasts = result.results || [];
      
      if (podcasts.length === 0) {
        return "No podcasts have been generated yet.";
      }

      const podcastList = podcasts.map((p: any) => 
        `• ${p.topic} - ${p.url} (Generated: ${new Date(p.created_at).toLocaleString()})`
      ).join('\n');

      return `📻 Recent podcasts (${podcasts.length}):\n\n${podcastList}`;
    } catch (error) {
      console.error("Failed to retrieve podcasts:", error);
      return `Failed to retrieve podcast list from database. Error: ${error}`;
    }
  }

  async recommendPodcast(mood: string) {
    console.log(`Looking for podcast recommendations based on mood: ${mood}`);
    
    try {
      // Get all podcasts from the database
      const stmt = this.env.DB.prepare(`
        SELECT topic, slug, url, created_at 
        FROM podcasts 
        ORDER BY created_at DESC
      `);
      
      const result = await stmt.all();
      const podcasts = result.results || [];
      
      if (podcasts.length === 0) {
        return "No podcasts have been generated yet. Generate some podcasts first to get recommendations!";
      }

      // Format podcasts list for AI analysis
      const podcastList = podcasts.map((p: any, index: number) => 
        `${index + 1}. Topic: "${p.topic}" | URL: ${p.url} | Created: ${new Date(p.created_at).toLocaleString()}`
      ).join('\n');

      // Use AI to analyze and recommend based on mood
      const messages = [
        {
          role: "system", 
          content: "You are a helpful podcast recommendation assistant. Based on a user's mood and available podcasts, recommend the best match and explain why."
        },
        {
          role: "user", 
          content: `User mood: "${mood}"\n\nAvailable podcasts:\n${podcastList}\n\nRecommend the best podcast that matches my mood.`
        }
      ];

      const aiResponse: any = await this.env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", { messages });
      
      if (aiResponse.response) {
        return `🎧 Podcast Recommendation for "${mood}":\n\n${aiResponse.response}`;
      } else {
        // Fallback to simple keyword matching
        const keywords = mood.toLowerCase().split(' ');
        const matches = podcasts.filter((podcast: any) => 
          keywords.some(keyword => podcast.topic.toLowerCase().includes(keyword))
        );
        
        if (matches.length > 0) {
          const match = matches[0];
          return `🎯 Found a matching podcast!\n\n"${match.topic}"\n🔗 Listen here: ${match.url}\n\nThis matches your mood: ${mood}`;
        } else {
          return `😔 No podcasts found matching "${mood}". Try generating some podcasts with topics you're interested in first!`;
        }
      }
    } catch (error) {
      console.error("Failed to get podcast recommendations:", error);
      return `Failed to get recommendations. Error: ${error}`;
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