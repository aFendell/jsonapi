import { NextRequest, NextResponse } from 'next/server';
import { ZodTypeAny, z } from 'zod';

import { openai } from '@/lib/openai';
import { EXAMPLE_ANSWER, EXAMPLE_PROMPT } from './example';
import { ASSISTANT_PROMPT } from './assistant-prompt';

type PromiseExecutor<T> = (
  resolve: (value: T) => void,
  reject: (reason?: any) => void
) => void;

class RetryablePromise<T> extends Promise<T> {
  static async retry<T>(
    retries: number,
    executor: PromiseExecutor<T>
  ): Promise<T> {
    return new RetryablePromise(executor).catch((error) => {
      console.error(`Retrying due to error: ${error}`);

      return retries > 0
        ? RetryablePromise.retry(retries - 1, executor)
        : RetryablePromise.reject(error);
    });
  }
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // step1: make sure incoming request is valid => data & format
  const genericSchema = z.object({
    data: z.string(),
    format: z.object({}).passthrough(),
  });

  const { data, format } = genericSchema.parse(body);

  // step 2: create schema from the expected user format
  const dynamicSchema = jsonSchemaToZod(format);

  // step 3: retry mechanism
  const validationResult = await RetryablePromise.retry<object>(
    3,
    async (resolve, reject) => {
      try {
        // call ai

        const content = `DATA: \n"${data}"\n\n-----------\nExpected JSON format: 
        ${JSON.stringify(format, null, 2)}
        \n\n-----------\nValid JSON output in expected format:`;

        // Currently getting
        // Error: 429 You exceeded your current quota, please check your plan and billing details.
        // TODO: Check openai docs / billing OR switch to a different ai solution.
        const res = await openai.chat.completions.create({
          model: 'gpt-3.5-turbo',
          messages: [
            {
              role: 'assistant',
              content: ASSISTANT_PROMPT,
            },
            {
              role: 'user',
              content: EXAMPLE_PROMPT,
            },
            {
              role: 'user',
              content: EXAMPLE_ANSWER,
            },
            {
              role: 'user',
              content,
            },
          ],
        });

        // text content from openai response
        const text = res.choices[0].message.content;

        // validate json
        const validationResult = dynamicSchema.parse(JSON.parse(text || ''));

        return resolve(validationResult);
      } catch (err) {
        reject(err);
      }
    }
  );

  return NextResponse.json(validationResult, { status: 200 });
}

function determainSchemaType(schema: any): string {
  if (!schema.hasOwnProperty('type')) {
    if (Array.isArray(schema)) {
      return 'array';
    } else {
      return typeof schema;
    }
  }

  return schema.type;
}

function jsonSchemaToZod(schema: any): ZodTypeAny {
  const type = determainSchemaType(schema);

  switch (type) {
    case 'string':
      return z.string().nullable();
    case 'number':
      return z.number().nullable();
    case 'boolean':
      return z.boolean().nullable();
    case 'array':
      return z.array(jsonSchemaToZod(schema.items)).nullable();
    case 'object':
      const shape: Record<string, ZodTypeAny> = {};

      for (const key in schema) {
        if (key !== 'type') {
          shape[key] = jsonSchemaToZod(schema[key]);
        }
      }

      return z.object(shape);
    default:
      throw new Error(`Unsupported data type: ${type}`);
  }
}
