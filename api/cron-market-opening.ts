import { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    try {
        const SUPABASE_URL = process.env.SUPABASE_URL || '';
        const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
        const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !GEMINI_API_KEY) {
            return res.status(500).json({ 
                success: false, 
                error: "Missing environment configuration on Vercel edge node (Supabase or Gemini keys)." 
            });
        }

        const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

        // 1. Fetch live asset pricing variables
        const cryptoPriceRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana,bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
        const priceData = await cryptoPriceRes.json();

        const solPrice = priceData?.solana?.usd || 'N/A';
        const solChange = priceData?.solana?.usd_24h_change?.toFixed(2) || '0.00';
        const btcPrice = priceData?.bitcoin?.usd || 'N/A';
        const ethPrice = priceData?.ethereum?.usd || 'N/A';

        const rawMarketContext = `
        Solana (SOL): $${solPrice} USD (24h Change: ${solChange}%)
        Bitcoin (BTC): $${btcPrice} USD
        Ethereum (ETH): $${ethPrice} USD
        System Time: ${new Date().toUTCString()}
        `;

        // 2. Draft the specialized behavioral prompt
        const systemInstruction = `You are an elite, highly tactical Web3 on-chain analyst and macro strategist for Project Apex terminal. Write a highly professional, dark-terminal styled morning briefing for crypto traders. Use short sentences, technical jargon, bolding, and terminal-style bullet points (•, ┣, ┗). Keep it concise. Return ONLY the formatted Telegram HTML text. Do not wrap the output in markdown block code chunks like \`\`\`html.`;

        const userPrompt = `Compile today's morning report using this data: ${rawMarketContext}. Structure it with a "GLOBAL LIQUIDITY MATRIX" showing the prices, a 3-bullet "TACTICAL RADAR ON-CHAIN IMPACT" breakdown, and a 1-sentence "OPERATIONAL SENTIMENT VERDICT". Wrap technical variables, symbols, or addresses in <code> tags.`;

        // 3. Dispatch directly to Google's Native Generation Endpoint (Using 1.5-flash for max stability)
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

        const geminiResponse = await fetch(geminiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{
                    parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }]
                }],
                generationConfig: {
                    temperature: 0.6,
                    maxOutputTokens: 800
                }
            })
        });

        if (!geminiResponse.ok) {
            const errText = await geminiResponse.text();
            return res.status(geminiResponse.status).json({
                success: false,
                error: `Gemini Gateway Error (Status ${geminiResponse.status})`,
                details: errText
            });
        }

        const geminiJson = await geminiResponse.json();
        const generatedBriefing = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!generatedBriefing) throw new Error("Gemini engine parsing anomaly: empty content payload returned.");

        // 4. Wrap inside our terminal dashboard layouts
        const finalReport = `<pre>
🌅 APEX DAILY MARKET OPENING
════════════════════════════════════</pre>
${generatedBriefing.trim()}
<pre>───────────────────────────────────
Intelligence compiled by Apex Gemini Node.</pre>`;

        // 5. Cache the result to Supabase
        const { error } = await supabase.from('system_reports').insert({
            report_type: 'market_opening',
            content: finalReport
        });

        if (error) throw error;

        return res.status(200).json({ success: true, message: "Gemini Morning Briefing compiled and cached." });

    } catch (error: any) {
        console.error("Gemini Automation Crash:", error);
        return res.status(500).json({ success: false, error: error.message });
    }
}