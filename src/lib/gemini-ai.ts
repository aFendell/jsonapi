import { GoogleGenerativeAI } from '@google/generative-ai';

const API_KEY = process.env.GEMINI_AI_KEY as string;

export const genAI = new GoogleGenerativeAI(API_KEY);
