import {
  buildIsQuestionPrompt,
  buildShouldEscalatePrompt,
} from "@vendeya/core";
import type OpenAI from "openai";
import { MODEL_CONFIG } from "../config";
import { parseLLMResponse } from "./shared";

export async function isQuestion(
  client: OpenAI,
  message: string,
): Promise<boolean> {
  const baseConfig = MODEL_CONFIG.classification;
  const opConfig = baseConfig.isQuestion;

  const completion = await client.chat.completions.create({
    model: baseConfig.model,
    ...(opConfig.temperature !== undefined && {
      temperature: opConfig.temperature,
    }),
    messages: [
      { role: "system", content: buildIsQuestionPrompt() },
      { role: "user", content: message },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message.content;
  const res = parseLLMResponse<{ isQuestion?: boolean }>(content, {});
  return res.isQuestion === true;
}

export async function shouldEscalate(
  client: OpenAI,
  message: string,
): Promise<boolean> {
  const baseConfig = MODEL_CONFIG.classification;
  const opConfig = baseConfig.shouldEscalate;

  const completion = await client.chat.completions.create({
    model: baseConfig.model,
    ...(opConfig.temperature !== undefined && {
      temperature: opConfig.temperature,
    }),
    messages: [
      { role: "system", content: buildShouldEscalatePrompt() },
      { role: "user", content: message },
    ],
    response_format: { type: "json_object" },
  });

  const content = completion.choices[0]?.message.content;
  const res = parseLLMResponse<{ shouldEscalate?: boolean }>(content, {});
  return res.shouldEscalate === true;
}
