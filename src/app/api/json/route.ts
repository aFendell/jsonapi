import { NextRequest, NextResponse } from 'next/server';
import { ZodTypeAny, z } from 'zod';

import { EXAMPLE_RESPONSE, EXAMPLE_PROMPT } from './example-prompts';
import { MODEL_PROMPT } from './model-prompt';
import { genAI } from '@/lib/gemini-ai';

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

  const genericSchema = z.object({
    data: z.string(),
    format: z.object({}).passthrough(),
  });

  const { data, format } = genericSchema.parse(body);

  const dynamicSchema = jsonSchemaToZod(format);

  const validationResult = await RetryablePromise.retry<object>(
    3,
    async (resolve, reject) => {
      try {
        const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

        const userContent = `DATA: \n"${data}"\n\n-----------\nExpected JSON format:
        ${JSON.stringify(format, null, 2)}
        \n\n-----------\nValid JSON output in expected format:`;

        const result = await model.generateContent({
          contents: [
            {
              role: 'model',
              parts: [{ text: MODEL_PROMPT }],
            },
            {
              role: 'user',
              parts: [{ text: EXAMPLE_PROMPT }],
            },
            {
              role: 'user',
              parts: [{ text: EXAMPLE_RESPONSE }],
            },
            {
              role: 'user',
              parts: [{ text: userContent }],
            },
          ],
        });

        const response = await result.response;

        const text = response.text();

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
