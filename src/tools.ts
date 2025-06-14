/**
 * Tool definitions for the AI chat agent
 * Tools can either require human confirmation or execute automatically
 */
import { tool } from "ai";
import { z } from "zod";


import { agentContext } from "./server";

/**
 * Weather information tool that requires human confirmation
 * When invoked, this will present a confirmation dialog to the user
 * The actual implementation is in the executions object below
 */
const getWeatherInformation = tool({
  description: "show the weather in a given city to the user",
  parameters: z.object({ city: z.string() }),
  // Omitting execute function makes this tool require human confirmation
});

/**
 * Local time tool that executes automatically
 * Since it includes an execute function, it will run without user confirmation
 * This is suitable for low-risk operations that don't need oversight
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
    // we can now read the agent context from the ALS store
    const agent = agentContext.getStore();
    if (!agent) {
      throw new Error("No agent found");
    }
    try {
      agent.schedule(
        type === "scheduled"
          ? new Date(when) // scheduled
          : type === "delayed"
            ? when // delayed
            : when, // cron
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
 * Tool for generating a podcast
 */
const generatePodcast = tool({
  description: "Generate a podcast about a given topic",
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
 * Export all available tools
 * These will be provided to the AI model to describe available capabilities
 */
export const tools = {
  getWeatherInformation,
  getLocalTime,
  scheduleTask,
  generatePodcast,
  listRecentPodcasts,
};

/**
 * Implementation of confirmation-required tools
 * This object contains the actual logic for tools that need human approval
 * Each function here corresponds to a tool above that doesn't have an execute function
 */
export const executions = {
  getWeatherInformation: async ({ city }: { city: string }) => {
    console.log(`Getting weather information for ${city}`);
    return `The weather in ${city} is sunny`;
  },
};