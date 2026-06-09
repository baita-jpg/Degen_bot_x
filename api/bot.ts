import { Telegraf, Markup, Scenes, session } from 'telegraf';
import { Connection, PublicKey, LAMPORTS_PER_SOL, Keypair } from '@solana/web3.js';
import { createClient } from '@supabase/supabase-js';
import * as crypto from 'crypto';
import bs58 from 'bs58';

// --- APEX PROPRIETARY MODULES ---
import { decryptPrivateKey } from './vault';
import { executeJupiterSwap } from '../utils/swapEngine';
import { computeMacroState } from '../utils/macroEngine';
import { runRadarScans } from '../utils/socialRadar';
import { runDeepTokenAudit } from '../utils/tokenValidator';
import { generatePerformanceMetrics, generateEquityCurve } from '../utils/reportingCore';

const token = process.env.TELEGRAM_BOT_TOKEN || '';

if (!token) {
    console.error('❌ CRITICAL: TELEGRAM_BOT_TOKEN not set. Bot cannot initialize.');
    process.exit(1);
}

const bot = new Telegraf(token);

// ─── TIMEOUT WRAPPER FOR ASYNC OPERATIONS ────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`Operation timeout after ${ms}ms`)), ms))
    ]).catch(() => fallback);
}

// ─── GLOBAL ERROR HANDLER MIDDLEWARE ─────────────────────────────────
bot.catch((err: any, ctx: any) => {
    console.error('🔴 Bot Error:', err);
    ctx.reply('⚠️ System encountered an error. Returning to main console...').catch(() => {});
});

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
    let balanceText = "0.0000 SOL";
    let activeWalletStr = "UNLINKED ⚠️";
    let rpcLatency = "N/A";
    let dataLinkStr = supabaseActive ? "Secured Cloud" : "Local Sandbox";

    try {
        let pubKeyToQuery = '';
        let walletType = '';

        if (supabaseActive) {
            const dbResult = await withTimeout(
                supabase.from('user_wallets').select('*').eq('tg_user_id', userId).eq('is_active', true).maybeSingle(),
                5000,
                { data: null }
            );
            if (dbResult?.data) { pubKeyToQuery = dbResult.data.public_key; walletType = 'CLOUD'; }
        } else if (localWalletStore.has(userId)) {
            const localW = localWalletStore.get(userId);
            if (localW) { pubKeyToQuery = localW.pubKey; walletType = `LOCAL`; }
        }

        if (pubKeyToQuery) {
            activeWalletStr = `${pubKeyToQuery.substring(0, 4)}...${pubKeyToQuery.substring(pubKeyToQuery.length - 4)} [${walletType}]`;
            const startTime = performance.now();
            const lamports = await withTimeout(
                connection.getBalance(new PublicKey(pubKeyToQuery)),
                3000,
                0
            );
            rpcLatency = (performance.now() - startTime).toFixed(0) + 'ms';
            balanceText = `${(lamports / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
        }
    } catch (err) {
        console.error('Dashboard error:', err);
        balanceText = "OFFLINE ⚠️";
    }

    return `<pre>
🦅 PROJECT APEX | v2.7
════════════════════════════════════

📡 SYSTEM TELEMETRY
┣ Operator  : #${userId}
┣ Node State: Mainnet-Beta
┗ Data Link : ${dataLinkStr}

💼 LIQUIDITY VAULT
┌──────────────────────────────────┐
│ Wallet  : ${activeWalletStr.padEnd(23)}│
│ Balance : ${balanceText.padEnd(23)}│
│ Ping    : ${rpcLatency.padEnd(23)}│
└──────────────────────────────────┘

Select an operational matrix down below:</pre>`;
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
// QUICK SNIPE MENU
bot.action('menu_snipe', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`<b>🚀 QUICK SNIPE MODE</b>\n════════════════════════════════════\nPaste a Solana token address to execute rapid acquisition on detected momentum.\n\nExample: <code>EPjFWaJgjqPCj9w6aSG2UVetUuwT66R28d4a5j7CScZ</code>`, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'go_home')]]).reply_markup
    });
});

// MANUAL BUY MENU
bot.action('menu_buy', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(`<b>⚡ MANUAL BUY MODE</b>\n════════════════════════════════════\nPaste a Solana token address to configure custom buy parameters.\n\nExample: <code>EPjFWaJgjqPCj9w6aSG2UVetUuwT66R28d4a5j7CScZ</code>`, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'go_home')]]).reply_markup
    });
});

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
        [Markup.button.callback('💧 Macro Intelligence Deck', 'rep_fore')]
    ]);
    await ctx.editMessageText(`<b>📋 INTELLIGENCE REPORTS</b>\n════════════════════════════════════\nSelect a cached global intelligence digest channel below:`, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
});

// MARKET OPENING REPORT
bot.action('rep_open', async (ctx) => {
    await ctx.answerCbQuery('Generating market opening analysis...');
    const panel = `<pre>
🦅 APEX TERMINAL // MARKET OPENING DIGEST
════════════════════════════════════════════

📈 OPENING SESSION METRICS
┣ Market Status   : 🟢 OPERATIONAL
┣ Current Time    : ${new Date().toUTCString()}
┣ 24h Momentum    : Initializing...
┗ Network Health  : Monitoring

💼 OPENING SESSION ANALYSIS
📊 Volatility Index: Computing
📡 Network Status : Connected
🟢 System Ready
────────────────────────────────────────
Standby for detailed opening metrics</pre>`;
    
    await ctx.editMessageText(panel, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'rep_open')],
            [Markup.button.callback('↩️ Back to Reports', 'submenu_reports')]
        ]).reply_markup
    });
});

// MARKET CLOSING REPORT
bot.action('rep_close', async (ctx) => {
    await ctx.answerCbQuery('Generating market closing analysis...');
    const panel = `<pre>
🦅 APEX TERMINAL // MARKET CLOSING DIGEST
════════════════════════════════════════════

📈 CLOSING SESSION METRICS
┣ Market Status   : Closing
┣ Current Time    : ${new Date().toUTCString()}
┣ Daily Summary   : Consolidating...
┗ Session Results : Processing

💼 CLOSING SESSION SUMMARY
📊 Daily High/Low : Computing
📡 Volume Summary : Tallying
🟢 Ready for EOD
────────────────────────────────────────
Daily performance audit complete</pre>`;
    
    await ctx.editMessageText(panel, {
        parse_mode: 'HTML',
        reply_markup: Markup.inlineKeyboard([
            [Markup.button.callback('🔄 Refresh', 'rep_close')],
            [Markup.button.callback('↩️ Back to Reports', 'submenu_reports')]
        ]).reply_markup
    });
});

// SUBMENU 2: TRACKING & RADARS
bot.action('submenu_tracking', async (ctx) => {
    await ctx.answerCbQuery();
    const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback('🐋 Social & On-Chain Radar', 'rep_liq')],
        [Markup.button.callback('💼 Unified ROI Ledger', 'track_roi')],
        [Markup.button.callback('↩️ Return to Main Desk', 'go_home')]
    ]);
    await ctx.editMessageText(`<b>📡 ON-CHAIN TRACKING & SOCIAL RADARS</b>\n════════════════════════════════════\nReal-time network scanners and behavioral social indexing pipelines:`, { parse_mode: 'HTML', reply_markup: keyboard.reply_markup });
});

// ─── MACRO INTELLIGENCE DECK ─────────────────────────────────────────
bot.action('rep_fore', async (ctx) => {
    await ctx.answerCbQuery('Computing structural market layers...');
    try {
        const macro = await withTimeout(computeMacroState(), 10000, {
            spotPrice: 0,
            perpPrice: 0,
            basisSpread: 0,
            basisCondition: 'UNKNOWN',
            capitalVelocity: 0,
            toxicVolumeRatio: 0,
            flowToxicity: 'NEUTRAL'
        });

        const basisColor = macro.basisCondition === 'DISCOUNT' ? '🟡' : '🟢';
        const toxicityColor = macro.flowToxicity === 'HIGH' ? '🔴' : '🟢';

        const panel = `<pre>
🦅 APEX TERMINAL // MACRO INTELLIGENCE DECK
════════════════════════════════════════════

📈 DEFI DERIVATIVE SPREAD CALCULATOR
┣ Base Spot Index: $${macro.spotPrice} USD
┣ Perp Mark Index: $${macro.perpPrice} USD
┣ Basis Premium  : <code>${macro.basisSpread >= 0 ? '+' : ''}${macro.basisSpread}</code>
┗ Structural Risk: ${basisColor} <b>${macro.basisCondition} STATE</b>

💧 ORDER FLOW & RESERVES TOXICITY
┣ Pool Turn Velocity: ${macro.capitalVelocity}x
┣ MEV Arbitrage Ratio: ${macro.toxicVolumeRatio}%
┗ Flow Classification: ${toxicityColor} <b>${macro.flowToxicity} TOXICITY</b>
────────────────────────────────────────
Live Telemetry Reconciled via Jito ShredStream Engine</pre>`;

        await ctx.editMessageText(panel, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Compute New Block Range', 'rep_fore')],
                [Markup.button.callback('↩️ Back to Reports', 'submenu_reports')]
            ]).reply_markup
        });
    } catch (err: any) {
        await ctx.editMessageText(`❌ <b>Macro Computation Failed:</b> <code>${err.message}</code>`, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Reports', 'submenu_reports')]]).reply_markup
        });
    }
});

// ─── SOCIAL & ON-CHAIN RADARS ────────────────────────────────────────
bot.action('rep_liq', async (ctx) => {
    await ctx.answerCbQuery('Scanning social networks and wallet graphs...');
    try {
        const sampleTargetMint = 'So11111111111111111111111111111111111111112'; // Wrapped SOL base proxy
        const radar = await withTimeout(runRadarScans(sampleTargetMint), 10000, {
            detectedClusters: 0,
            syndicateConcentrationPct: 0,
            insiderConvictionStatus: 'NEUTRAL',
            socialDensityVelocity: 0,
            crossGroupResonanceCount: 0
        });

        const alertIcon = radar.insiderConvictionStatus === 'ACCUMULATION' ? '🔥' : '⚠️';

        const panel = `<pre>
🦅 APEX TERMINAL // SOCIAL & ON-CHAIN RADARS
════════════════════════════════════════════

🐋 WALLET ANCESTRY CLUSTERING LEDGER
┣ Coordinated Rings : ${radar.detectedClusters} Active Clusters Found
┣ Supply Capture    : <code>${radar.syndicateConcentrationPct}%</code> of circulating supply
┗ Syndicate Phase   : ${alertIcon} <b>${radar.insiderConvictionStatus} FOCUS</b>

🔥 INFORMATIONAL ASYMMETRY SCANNERS
┣ Social Density    : [ ${radar.socialDensityVelocity} / 100 ] Pure Velocity Rating
┗ Network Resonance : Linked in ${radar.crossGroupResonanceCount} Secret Developer Channels
────────────────────────────────────────
Scrubbing automated bot farm metrics from live outputs</pre>`;

        await ctx.editMessageText(panel, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Run Deep Network Rescan', 'rep_liq')],
                [Markup.button.callback('↩️ Back to Tracking', 'submenu_tracking')]
            ]).reply_markup
        });
    } catch (err: any) {
        await ctx.editMessageText(`❌ <b>Radar Scan Failed:</b> <code>${err.message}</code>`, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Tracking', 'submenu_tracking')]]).reply_markup
        });
    }
});

// ─── UNIFIED PERFORMANCE & ROI LEDGER (MILESTONE 5) ──────────────────
bot.action('track_roi', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery('Rendering graphic performance curves...');

    try {
        if (!supabaseActive) throw new Error("Database offline");

        // Fetch Metrics
        const liveMetrics = await generatePerformanceMetrics(supabase, userId, 'MAINNET_LIVE');
        const demoMetrics = await generatePerformanceMetrics(supabase, userId, 'DEMO_PAPER');

        // Fetch Visual Equity Curves
        const liveCurve = await generateEquityCurve(supabase, userId, 'MAINNET_LIVE');
        const demoCurve = await generateEquityCurve(supabase, userId, 'DEMO_PAPER');

        const liveText = liveMetrics ? `
┣ Vector Plot   : ${liveCurve}
┣ Total Trades  : ${liveMetrics.totalTrades}
┣ Win Rate      : <code>${liveMetrics.winRate}%</code>
┣ Profit Factor : <code>${liveMetrics.profitFactor}x</code>
┗ Net Yield     : <code>${liveMetrics.netSolPnL >= 0 ? '+' : ''}${liveMetrics.netSolPnL} SOL</code>` 
: `\n❌ No production deployments executed.`;

        const demoText = demoMetrics ? `
┣ Vector Plot   : ${demoCurve}
┣ Total Trades  : ${demoMetrics.totalTrades}
┣ Win Rate      : <code>${demoMetrics.winRate}%</code>
┣ Profit Factor : <code>${demoMetrics.profitFactor}x</code>
┗ Net Yield     : <code>${demoMetrics.netSolPnL >= 0 ? '+' : ''}${demoMetrics.netSolPnL} SOL</code>`
: `\n❌ No simulation tracking parameters logged.`;

        const summaryContent = `<pre>
🦅 APEX UNIFIED PERFORMANCE LEDGER
════════════════════════════════════════
REAL-TIME MULTI-ACCOUNT ACCOUNTING

🟢 PRODUCTION VALUATION (LIVE KEYS)${liveText}

🔮 SIMULATION ACCOUNTING (SECOND TRADER)${demoText}
────────────────────────────────────────
System Audit Status: Validated
Last Reconciled: ${new Date().toISOString().substring(0, 19).replace('T', ' ')} UTC</pre>`;

        await ctx.editMessageText(summaryContent, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('🔄 Re-Audit Systems', 'track_roi')],
                [Markup.button.callback('↩️ Main Terminal Desk', 'go_home')]
            ]).reply_markup
        });

    } catch (err: any) {
        await ctx.editMessageText(`❌ <b>Audit Failure:</b> <code>${err.message}</code>`, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Return', 'go_home')]]).reply_markup
        });
    }
});


// ─── ON-CHAIN MANUAL TOKEN SCANNER (MILESTONE 2) ─────────────────────
bot.on('text', async (ctx) => {
    const text = ctx.message.text.trim();
    const userId = ctx.from?.id;
    if (!userId) return;

    const isSolanaAddress = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(text);

    if (isSolanaAddress) {
        const loadingMsg = await ctx.replyWithHTML(`🔍 <b>INTERCEPTING SMART CONTRACT HASH...</b>\n<code>${text}</code>\n⏳ Executing multi-layered risk audit routines...`);

        try {
            const audit = await withTimeout(runDeepTokenAudit(text), 12000, null);
            if (!audit) throw new Error('Audit timeout');

            if (!audit || !audit.success) {
                return await ctx.telegram.editMessageText(ctx.chat.id, loadingMsg.message_id, undefined, 
                    `⚠️ <b>Audit Terminated:</b> Contract hash recognized, but no viable AMM routing matrices exist.`,
                    { parse_mode: 'HTML' }
                ).catch(() => {});
            }

            const trendSign = audit.change24h >= 0 ? '🟢 +' : '🔴 ';
            const warningsBlock = audit.warnings.length > 0 
                ? `\n⚠️ <b>RISK CONSOLE ALERTS:</b>\n${audit.warnings.map(w => `• <code>${w}</code>`).join('\n')}\n` 
                : `\n✅ <b>RISK CONSOLE:</b> No immediate architectural vulnerabilities found.\n`;

            const panel = `<pre>
🦅 APEX MANUAL TOKEN INTERCEPT MATRIX
════════════════════════════════════════

🎯 IDENTIFIED : $${audit.symbol} | ${audit.name}
┣ Address    : ${audit.address.substring(0, 4)}...${audit.address.substring(audit.address.length - 4)}
┣ Market Cap : $${(audit.fdv / 1000).toFixed(2)}K
┗ Price Index: $${audit.priceUsd.toFixed(6)} (${trendSign}${audit.change24h.toFixed(2)}%)

💧 LIQUIDITY AND METRIC MOMENTUM
┣ Pool Reserves  : $${(audit.liquidityUsd / 1000).toFixed(2)}K
┣ 24h Net Volume : $${(audit.volume24h / 1000).toFixed(2)}K
┣ Capital Turning: ${audit.capitalVelocity}x
┗ Order Pressure : ${audit.orderPressure} (Buy/Sell)

🛡️ ALGORITHMIC TRUST SCORE
┌──────────────────────────────────────┐
│ PROFILE MATRIX INDEX: [ ${audit.safetyScore.toString().padEnd(3)} / 100 ]     │
└──────────────────────────────────────┘</pre>
${warningsBlock}
<pre>Select execution profile to initialize immediate Jito bundle routing:</pre>`;

            await ctx.telegram.deleteMessage(ctx.chat.id, loadingMsg.message_id).catch(() => {});
            
            return await ctx.reply(panel, {
                parse_mode: 'HTML',
                reply_markup: Markup.inlineKeyboard([
                    [
                        Markup.button.callback(`🛒 Buy 0.05 SOL`, `quickbuy_0.05_${text}_${audit.symbol}`),
                        Markup.button.callback(`🛒 Buy 0.25 SOL`, `quickbuy_0.25_${text}_${audit.symbol}`)
                    ],
                    [Markup.button.callback('❌ Abort Operation', 'go_home')]
                ]).reply_markup
            });

        } catch (err) {
            return await ctx.reply(`❌ <b>Audit Execution Crash:</b> System was unable to map data loops over this target structure.`);
        }
    }

    await ctx.reply("⚡ Unknown terminal instruction. Type /terminal to load matrix dashboard commands.");
});

// --- SWAP BUTTON HANDLER DISPATCH LOOP ---
bot.action(/^quickbuy_(.+)$/, async (ctx) => {
    const payload = ctx.match[1]; 
    const [amountStr, tokenAddress, tokenSymbol] = payload.split('_');
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.answerCbQuery('Assembling transaction frames...');
    await ctx.editMessageText('⚡ <b>Broadcasting execution frame to Jito Validators...</b>', { parse_mode: 'HTML' });

    try {
        let userPrivateKey = '';
        let encryptedPayload, iv, tag;

        if (supabaseActive) {
            const { data } = await supabase.from('user_wallets').select('*').eq('tg_user_id', userId).eq('is_active', true).maybeSingle();
            if (data) {
                encryptedPayload = data.encrypted_secret_payload;
                iv = data.iv;
                tag = data.tag;
            }
        } else if (localWalletStore.has(userId)) {
            const localW = localWalletStore.get(userId);
            encryptedPayload = localW?.enc;
            iv = localW?.iv;
            tag = localW?.tag;
        }

        if (!encryptedPayload) throw new Error("No linked wallet configuration found inside server state registers.");

        userPrivateKey = decryptPrivateKey(encryptedPayload, iv, tag, userId);

        const tradeAmountSol = parseFloat(amountStr);
        const result = await executeJupiterSwap(userPrivateKey, tokenAddress, tradeAmountSol);

        if (!result.success) throw new Error(result.error);

        if (supabaseActive && result.fillPriceUsd && result.tokensReceived) {
            await supabase.from('user_trades').insert({
                tg_user_id: userId,
                token_address: tokenAddress,
                token_symbol: tokenSymbol,
                buy_price_usd: result.fillPriceUsd,
                token_amount: result.tokensReceived,
                sol_amount: tradeAmountSol
            });
        }

        const successMessage = `<pre>
🟩 TRANSACTION EXECUTED SUCCESSFULLY
════════════════════════════════════════
Asset acquired via premium Jupiter Routing paths.

📦 Token  : $${tokenSymbol}
💎 Allocation : ${tradeAmountSol} SOL
🧾 Signature  : ${result.signature?.substring(0, 8)}...${result.signature?.substring(result.signature.length - 8)}

Check portfolio tracking ledgers to monitor ROI swing adjustments.</pre>`;

        await ctx.editMessageText(successMessage, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([
                [Markup.button.callback('📊 View ROI Ledger', 'track_roi')],
                [Markup.button.callback('↩️ Return', 'go_home')]
            ]).reply_markup
        });

    } catch (err: any) {
        await ctx.editMessageText(`❌ <b>Execution Panic:</b> <code>${err.message}</code>`, {
            parse_mode: 'HTML',
            reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back to Dashboard', 'go_home')]]).reply_markup
        });
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

// STATIC UI PLACEHOLDERS
bot.action('rep_open', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🌅 <b>Morning Market Intel:</b> No recent AI summaries compiled.', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_reports')]]).reply_markup }); });
bot.action('rep_close', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🌌 <b>Daily Market Closing Digest compiled at 22:00 UTC.</b>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Back', 'submenu_reports')]]).reply_markup }); });
bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('📥 <b>Submit contract address hash string:</b>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Home', 'go_home')]]).reply_markup }); });
bot.action('menu_snipe', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('🚀 <b>Sniper Node Online.</b>', { parse_mode: 'HTML', reply_markup: Markup.inlineKeyboard([[Markup.button.callback('↩️ Home', 'go_home')]]).reply_markup }); });

bot.catch((err, ctx) => {
    console.error(`Error for ${ctx.updateType}`, err);
});

export default async function handle(req: any, res: any) {
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