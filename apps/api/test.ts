import { GoogleGenerativeAI } from '@google/generative-ai';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    
    // Test 1 — Check dimension of gemini-embedding-001
    console.log("Testing models/gemini-embedding-001...");
    const model1 = genAI.getGenerativeModel({ model: "models/gemini-embedding-001" });
    const result1 = await model1.embedContent("test braking rules");
    console.log("gemini-embedding-001 dimensions:", result1.embedding.values.length);

    // Test 2 — Check actual stored vector dimension in Supabase
    console.log("\nNow check Supabase SQL editor:");
    console.log("Run: select vector_dims(embedding) from rulebook_chunks limit 1;");
}

main().catch(console.error);