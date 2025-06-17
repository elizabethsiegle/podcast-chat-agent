/**
 * Tool definitions for the AI chat agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool } from "ai";
import { z } from "zod";
import { agentContext } from "./server";

/**
 * Weather information tool that requires human confirmation
 */
const getWeatherInformation = tool({
  description: "show the weather in a given city to the user",
  parameters: z.object({ city: z.string() }),
  // Omitting execute function makes this tool require human confirmation
});

/**
 * Local time tool that executes automatically
 */
const getLocalTime = tool({
  description: "get the local time for a specified location",
  parameters: z.object({ location: z.string() }),
  execute: async ({ location }) => {
    console.log(`Getting local time for ${location}`);
    return "10am";
  },
});

const scheduleTask = tool({
  description:
    "schedule a task to be executed at a later time. 'when' can be a date, a delay in seconds, or a cron pattern.",
  parameters: z.object({
    type: z.enum(["scheduled", "delayed", "cron"]),
    when: z.union([z.number(), z.string()]),
    payload: z.string(),
  }),
  execute: async ({ type, when, payload }) => {
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    try {
      agent.schedule(
        type === "scheduled"
          ? new Date(when)
          : type === "delayed"
            ? when
            : when,
        "executeTask",
        payload
      );
    } catch (error) {
      console.error("error scheduling task", error);
      return `Error scheduling task: ${error}`;
    }
    return `Task scheduled for ${when}`;
  },
});

/**
 * Tool for generating a basic podcast (rickroll version)
 */
const generatePodcast = tool({
  description: "Generate a basic podcast page about a given topic (rickroll version)",
  parameters: z.object({
    topic: z.string().describe("A topic to generate a podcast about"),
  }),
  execute: async ({ topic }) => {
    const agent = agentContext.getStore();
    console.log("agent", agent);
    return await agent!.generatePodcast(topic);
  },
});

/**
 * Tool for creating an audio podcast with MP3 generation
 */
const createAudioPodcast = tool({
  description: "Create a complete audio podcast with MP3 file generation and script for a given topic",
  parameters: z.object({
    topic: z.string().describe("A topic to create an audio podcast about"),
    accessibilityMode: z.string().optional().describe("Set to 'accessible' for longer transcript, otherwise 'standard' for shorter format"),
  }),
  execute: async ({ topic, accessibilityMode = "standard" }) => {
    const agent = agentContext.getStore();
    console.log("Creating audio podcast for:", topic);
    return await agent!.createAudioPodcast(topic, accessibilityMode);
  },
});

/**
 * Tool for listing recent podcasts
 */
const listRecentPodcasts = tool({
  description: "List recent podcasts that have been generated",
  parameters: z.object({
    limit: z.number().optional().describe("Number of recent podcasts to retrieve (default: 10)"),
  }),
  execute: async ({ limit = 10 }) => {
    const agent = agentContext.getStore();
    return await agent!.listRecentPodcasts(limit);
  },
});

/**
 * Tool for getting podcast recommendations based on mood
 */
const recommendPodcast = tool({
  description: "Get podcast recommendations based on user's mood or preferences",
  parameters: z.object({
    mood: z.string().describe("The user's current mood or content preference (e.g., 'relaxed', 'energetic', 'educational', 'funny')"),
  }),
  execute: async ({ mood }) => {
    const agent = agentContext.getStore();
    return await agent!.recommendPodcast(mood);
  },
});

/**
 * Export all available tools
 */
export const tools = {
  getWeatherInformation,
  getLocalTime,
  scheduleTask,
  generatePodcast,
  createAudioPodcast,
  listRecentPodcasts,
  recommendPodcast,
};

/**
 * Implementation of confirmation-required tools
 */
export const executions = {
  getWeatherInformation: async ({ city }: { city: string }) => {
    console.log(`Getting weather information for ${city}`);
    return `The weather in ${city} is sunny`;
  },
};