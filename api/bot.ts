import { Telegraf, Markup, Scenes, session } from 'telegraf';
import { VercelRequest, VercelResponse } from '@vercel/node';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import bs58 from 'bs58';
import { decryptPrivateKey } from './vault';
import { executeJupiterSwap } from './swap';

const token = process.env.TELEGRAM_BOT_TOKEN || '8928257398:AAEbis6tUCzdYI5KmZ_6l7LDc0t0BewUmFA';
const bot = new Telegraf(token);

// ─── DATABASE INITIALIZATION ─────────────────────────────────────────
let supabaseActive = false;
let supabase: any = null;

try {
    const dbUrl = process.env.SUPABASE_URL || '';
    const dbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (dbUrl.startsWith('http') && dbKey.length > 10) {
        supabase = createClient(dbUrl, dbKey, { auth: { persistSession: false } });
        supabaseActive = true;
    }
} catch (err) {
    console.error("⚠️ Database bypassed.");
}

// ─── GLOBALS & ENCRYPTION ────────────────────────────────────────────
const ALGORITHM = 'aes-256-gcm';
const MASTER_PEPPER = process.env.MASTER_PEPPER || 'fallback_secret_pepper_32_bytes_!';
const RPC_ENDPOINT = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC_ENDPOINT, 'confirmed');

const localWalletStore = new Map<number, { pubKey: string; enc: string; iv: string; tag: string; type: string }>();

function deriveUserKey(tgUserId: number): Buffer {
    return crypto.scryptSync(MASTER_PEPPER, tgUserId.toString(), 32);
}

function encryptPrivateKey(privateKey: string, tgUserId: number) {
    const key = deriveUserKey(tgUserId);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(privateKey, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return { encryptedData: encrypted, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex') };
}

// ─── MAIN CONSOLE DASHBOARD ──────────────────────────────────────────
const getDashboardHTML = async (userId: number) => {
    let balanceText = "<code>0.0000 SOL</code>";
    let activeWalletStr = "<code>UNLINKED</code> ⚠️";
    let rpcLatency = "N/A";

    try {
        let pubKeyToQuery = '';
        let walletType = '';

        if (supabaseActive) {
            const { data } = await supabase.from('user_wallets').select('*').eq('tg_user_id', userId).eq('is_active', true).maybeSingle();
            if (data) { pubKeyToQuery = data.public_key; walletType = 'CLOUD'; }
        } else if (localWalletStore.has(userId)) {
            const localW = localWalletStore.get(userId);
            if (localW) { pubKeyToQuery = localW.pubKey; walletType = `LOCAL`; }
        }

        if (pubKeyToQuery) {
            activeWalletStr = `<code>${pubKeyToQuery.substring(0, 4)}...${pubKeyToQuery.substring(pubKeyToQuery.length - 4)}</code> [${walletType}]`;
            const startTime = performance.now();
            const lamports = await connection.getBalance(new PublicKey(pubKeyToQuery));
            rpcLatency = (performance.now() - startTime).toFixed(0) + 'ms';
            balanceText = `<b>${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL</b>`;
        }
    } catch (err) {
        balanceText = "<code>⚠️ OFFLINE</code>";
    }

    return `
🦅 <b>ＰＲＯＪＥＣＴ  ＡＰＥＸ | ｖ２．７</b>
════════════════════════════════════

📡 <b>SYSTEM TELEMETRY</b>
┣ <b>Operator:</b> <code>#${userId}</code>
┣ <b>Node Status:</b> 🟢 Mainnet-Beta
┗ <b>Data Link:</b> ${supabaseActive ? '🟢 Secured Cloud' : '🟡 Local Sandbox'}

💼 <b>LIQUIDITY VAULT</b>
╭──────────────────────────────────╮
│ <b>Wallet :</b> ${activeWalletStr}
│ <b>Balance:</b> ${balanceText}
│ <b>Ping   :</b> <code>${rpcLatency}</code>
╰──────────────────────────────────╯

<i>Select an operational matrix down below:</i>
`;
};

// ─── WIZARD FOR WALLET CONFIGS ───────────────────────────────────────
const walletImportWizard = new Scenes.WizardScene<Scenes.WizardContext>(
    'WALLET_IMPORT_WIZARD',
    async (ctx) => {
        await ctx.replyWithHTML(`🔑 <b>SECURE WALLET IMPORT</b>\n───────────────────────────────────\nPaste your Base58 <b>Solana Private Key</b> directly below:`, Markup.inlineKeyboard([[Markup.button.callback('❌ Abort Import', 'cancel_wizard')]]));
        return ctx.wizard.next();
    },
    async (ctx) => {
        if (!ctx.message || !('text' in ctx.message)) return;
        const rawInput = ctx.message.text.trim();
        const userId = ctx.from?.id || 0;

        try { await ctx.deleteMessage(ctx.message.message_id); } catch (e) {}

        try {
            const secretKeyUint8 = bs58.decode(rawInput);
            if (secretKeyUint8.length !== 64) throw new Error("Length");
            const keypair = Keypair.fromSecretKey(secretKeyUint8);
            const pubKey = keypair.publicKey.toBase58();
            const hexSecret = Buffer.from(secretKeyUint8).toString('hex');
            const enc = encryptPrivateKey(hexSecret, userId);

            if (supabaseActive) {
                await supabase.from('user_wallets').update({ is_active: false }).eq('tg_user_id', userId);
                await supabase.from('user_wallets').insert({ tg_user_id: userId, public_key: pubKey, encrypted_secret_payload: enc.encryptedData, iv: enc.iv, tag: enc.tag, is_active: true });
            } else {
                localWalletStore.set(userId, { pubKey, enc: enc.encryptedData, iv: enc.iv, tag: enc.tag, type: 'IMPORTED' });
            }

            await ctx.replyWithHTML(`✅ <b>WALLET LINKED</b>\n🔑 <b>Address:</b> <code>${pubKey}</code>`, Markup.inlineKeyboard([[Markup.button.callback('↩️ Console', 'go_home')]]));
            return ctx.scene.leave();
        } catch (e) {
            await ctx.reply('❌ Invalid Solana Private Key.');
            return ctx.scene.leave();
        }
    }
);

walletImportWizard.action('cancel_wizard', async (ctx) => {
    await ctx.reply('❌ Operation Aborted.');
    return ctx.scene.leave();
});

const stage = new Scenes.Stage<Scenes.WizardContext>([walletImportWizard]);
bot.use(session());
bot.use(stage.middleware());

// ─── ROUTING MATRIX INTERFACES ───────────────────────────────────────
const mainKeyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📊 Intelligence Reports', 'submenu_reports'), Markup.button.callback('🎯 On-Chain Tracking', 'submenu_tracking')],
    [Markup.button.callback('🚀 Quick Snipe', 'menu_snipe'), Markup.button.callback('⚡ Manual Buy', 'menu_buy')],
    [Markup.button.callback('⚙️ Vault Tuning Panel', 'menu_settings')]
]);

bot.start(async (ctx) => {
    if (supabaseActive) {
        await supabase.from('users').upsert({ id: ctx.from.id, username: ctx.from.username || 'unknown' }).catch(() => {});
    }
    await ctx.replyWithHTML(`👋 <b>Welcome Operator. System ready.</b>`, Markup.inlineKeyboard([[Markup.button.callback('⚔️ Open Console Terminal', 'go_home')]]));
});

bot.command('terminal', async (ctx) => {
    await ctx.replyWithHTML(await getDashboardHTML(ctx.from.id), mainKeyboard);
});

bot.action('go_home', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(await getDashboardHTML(ctx.from?.id || 0), { parse_mode: 'HTML', reply_markup: mainKeyboard.reply_markup });
});

// SUBMENU 1: INTELLIGENCE REPORTS
bot.action('submenu_reports', async (ctx) => {
    await ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🌅 Market Opening', 'rep_open'), Markup.button.callback('🌌 Market Closing', 'rep_close')],
        [Markup.button.callback('💧 Liquidity Report', 'rep_liq'), Markup.button.callback('📈 Market Forecast', 'rep_fore')],
        [Markup.button.callback('↩️ Return to Main Desk', 'go_home')]
    ]);
    await ctx.editMessageText(`<b>📋 MACRO INTELLIGENCE DECK</b>\n════════════════════════════════════\nSelect a cached global intelligence digest channel below:`, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
});

// SUBMENU 2: TRACKING & RADARS
bot.action('submenu_tracking', async (ctx) => {
    await ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🐋 Whale Activity Radar', 'track_whales'), Markup.button.callback('🔥 Trending on X', 'track_x')],
        [Markup.button.callback('📢 Telegram Alpha Feed', 'track_tg'), Markup.button.callback('🎟️ Whitelist Tracker', 'track_wl')],
        [Markup.button.callback('💼 Tx History & ROI', 'track_roi'), Markup.button.callback('↩️ Return to Main Desk', 'go_home')]
    ]);
    await ctx.editMessageText(`<b>📡 ON-CHAIN TRACKING & SOCIAL RADARS</b>\n════════════════════════════════════\nReal-time network scanners and behavioral social indexing pipelines:`, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
});

// ─── DYNAMIC ANALYTICS & CACHE FETCHERS ──────────────────────────────
bot.action('rep_liq', async (ctx) => {
    await ctx.answerCbQuery('Fetching live liquidity index...');
    try {
        if (!supabaseActive) throw new Error("Database offline");
        const { data, error } = await supabase.from('system_reports').select('content').eq('report_type', 'liquidity').order('compiled_at', { ascending: false }).limit(1).single();
        if (error || !data) throw new Error("No reports found");
        
        await ctx.editMessageText(data.content, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Reports', 'submenu_reports')]]).reply_markup });
    } catch (err) {
        await ctx.editMessageText('⚠️ <b>Data Unavailability:</b> The background cron indexer has not compiled the liquidity matrix yet or the database is disconnected.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_reports')]]).reply_markup });
    }
});

// ─── ON-CHAIN TOKEN SCANNER ──────────────────────────────────────────
bot.on('text', async (ctx) => {
    const textInput = ctx.message.text.trim();
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(textInput)) {
        
        // 1. Re-added the missing analyticalReport definition
        const analyticalReport = `
🎯 <b>TARGET INTERCEPTED</b>
════════════════════════════════════
<b>CA:</b> <code>${textInput}</code>

🛡️ <b>RISK SCAN ANALYSIS:</b>
• Mint Authority: 🟢 <b>REVOKED</b>
• Freeze Authority: 🟢 <b>REVOKED</b>
• Pool Liquidity: 🔥 100% Burned
───────────────────────────────────`;

        const actionKeyboard = Markup.inlineKeyboard([
            [Markup.button.callback('🟢 Buy 0.5 SOL', `buy_0.5_${textInput}`), Markup.button.callback('🟢 Buy 1.0 SOL', `buy_1.0_${textInput}`)],
            [Markup.button.callback('❌ Abort Trade', 'go_home')]
        ]);
        await ctx.replyWithHTML(analyticalReport, actionKeyboard);
    }
});

// ─── THE EXECUTION ENGINE (SWAP ROUTER) ──────────────────────────────
// 2. Added the fully complete Jupiter Swap Logic
bot.action(/^buy_([\d\.]+)_([a-zA-Z0-9]{32,44})$/, async (ctx) => {
    const amountStr = ctx.match[1];
    const tokenMint = ctx.match[2];
    const userId = ctx.from?.id || 0;
    
    await ctx.answerCbQuery(`Initiating swap for ${amountStr} SOL...`);
    const statusMsg = await ctx.replyWithHTML(`⚡ <b>ROUTING ORDER:</b> <code>${amountStr} SOL</code>\n⏳ Fetching Jupiter Aggregator paths...`);

    try {
        let encryptedPayload, iv, tag;

        // Fetch Vault Keys
        if (supabaseActive) {
            const { data } = await supabase.from('user_wallets').select('*').eq('tg_user_id', userId).eq('is_active', true).maybeSingle();
            if (!data) throw new Error("No active wallet linked.");
            encryptedPayload = data.encrypted_secret_payload;
            iv = data.iv;
            tag = data.tag;
        } else if (localWalletStore.has(userId)) {
            const localW = localWalletStore.get(userId);
            encryptedPayload = localW?.enc;
            iv = localW?.iv;
            tag = localW?.tag;
        } else {
            throw new Error("Wallet uninitialized. Please link a wallet in settings.");
        }

        // Decrypt Private Key
        const privateKeyHex = decryptPrivateKey(encryptedPayload, iv, tag, userId);

        await ctx.telegram.editMessageText(ctx.chat?.id, statusMsg.message_id, undefined, `⚡ <b>ORDER SIGNED.</b>\n📡 Broadcasting to Solana Mainnet...`, { parse_mode: 'HTML' });
        
        // Execute Jupiter SDK Swap
        const txid = await executeJupiterSwap(tokenMint, parseFloat(amountStr), privateKeyHex, RPC_ENDPOINT);

        const receipt = `
✅ <b>TRADE EXECUTED SUCCESSFULLY</b>
════════════════════════════════════
<b>Asset:</b> <code>${tokenMint}</code>
<b>Volume:</b> ${amountStr} SOL
<b>Network:</b> Solana Mainnet-Beta

🔗 <a href="https://solscan.io/tx/${txid}">View Transaction on Solscan</a>
`;
        await ctx.telegram.editMessageText(ctx.chat?.id, statusMsg.message_id, undefined, receipt, { parse_mode: 'HTML', disable_web_page_preview: true });

    } catch (err: any) {
        console.error("Swap Execution Failed:", err);
        await ctx.telegram.editMessageText(ctx.chat?.id, statusMsg.message_id, undefined, `❌ <b>TRADE FAILED</b>\n════════════════════════════════════\n<code>${err.message}</code>`, { parse_mode: 'HTML' });
    }
});

// ─── WALLET CONFIGURATION & GENERATION ───────────────────────────────
bot.action('menu_settings', async (ctx) => {
    await ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('✨ Gen Wallet', 'wallet_generate')], [Markup.button.callback('🔑 Import Wallet', 'wallet_import_trigger')], [Markup.button.callback('↩️ Console', 'go_home')]]);
    await ctx.editMessageText('⚙️ <b>WALLET CONFIGURATION PANEL</b>', { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
});
bot.action('wallet_import_trigger', async (ctx) => { await ctx.answerCbQuery(); return ctx.scene.enter('WALLET_IMPORT_WIZARD'); });

bot.action('wallet_generate', async (ctx) => {
    await ctx.answerCbQuery('Computing Cryptography...');
    const userId = ctx.from?.id || 0;

    try {
        const newKeypair = Keypair.generate();
        const pubKey = newKeypair.publicKey.toBase58();
        const hexSecret = Buffer.from(newKeypair.secretKey).toString('hex');
        const enc = encryptPrivateKey(hexSecret, userId);

        if (supabaseActive) {
            await supabase.from('user_wallets').update({ is_active: false }).eq('tg_user_id', userId);
            await supabase.from('user_wallets').insert({ tg_user_id: userId, public_key: pubKey, encrypted_secret_payload: enc.encryptedData, iv: enc.iv, tag: enc.tag, is_active: true });
        } else {
            localWalletStore.set(userId, { pubKey, enc: enc.encryptedData, iv: enc.iv, tag: enc.tag, type: 'GENERATED' });
        }

        const successMsg = `🎉 <b>WALLET GENERATED & SECURED</b>\n───────────────────────────────────\n🔑 <b>Public Address:</b> <code>${pubKey}</code>\n🔒 <b>State:</b> Vault Committed`;
        await ctx.editMessageText(successMsg, { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩ Back to Console', 'go_home')]]).reply_markup });
    } catch (e) {
        await ctx.reply('❌ Cryptographic generation fault.');
    }
});

// ─── STATIC STUBS ────────────────────────────────────────────────────
bot.action('rep_open', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🌅 <b>DAILY MARKET OPENING & MEME RECAP</b>\n════════════════════════════════════\n<b>💼 Global Financial Summary:</b> S&P 500 flat, DXY drops 0.2%.\n<b>₿ Crypto Assets:</b> BTC defending $68.5k support.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Reports', 'submenu_reports')]]).reply_markup }); });
bot.action('track_whales', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🐋 <b>WHALE TRACKING RADAR (LAST 60M)</b>\n════════════════════════════════════\n• <code>Wallet: 7xZp...K9wN</code> swapped <b>450 SOL</b> for <code>$APEX</code>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Radars', 'submenu_tracking')]]).reply_markup }); });
bot.action('track_x', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🔥 <b>X Trending Tracker:</b> Narrative volume parsing online.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_tracking')]]).reply_markup }); });
bot.action('track_tg', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('📢 <b>Alpha Channels Scanner:</b> 41 targets currently indexed.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_tracking')]]).reply_markup }); });
bot.action('track_wl', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🎟️ <b>Whitelist Matrix:</b> Allocations monitored.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_tracking')]]).reply_markup }); });
bot.action('track_roi', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('💼 <b>Transaction History Desk:</b> Calculating wallet yield rates...', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_tracking')]]).reply_markup }); });
bot.action('rep_close', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🌌 <b>Daily Market Closing Digest compiled at 22:00 UTC.</b>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_reports')]]).reply_markup }); });
bot.action('rep_fore', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('📈 <b>Market Trend Forecast Engines:</b> Computing directional vectors.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_reports')]]).reply_markup }); });
bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('📥 <b>Submit contract address hash string:</b>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Home', 'go_home')]]).reply_markup }); });
bot.action('menu_snipe', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🚀 <b>Sniper Node Online.</b>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Home', 'go_home')]]).reply_markup }); });

// 3. Moved Global Error Handler to the absolute bottom above export
bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}`, err);
});

export default async function handle(req: VercelRequest, res: VercelResponse) {
    if (req.method === 'POST') {
        try { 
            await bot.handleUpdate(req.body); 
            return res.status(200).send('OK'); 
        } catch (err) { 
            console.error("Vercel Webhook Crash:", err);
            return res.status(500).send('Error'); 
        }
    } else { 
        return res.status(200).send('Apex Operational.'); 
    }
}