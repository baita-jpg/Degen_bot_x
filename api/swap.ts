// api/swap.ts
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

// Native SOL Mint Address
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export async function executeJupiterSwap(
    tokenMint: string,
    solAmount: number,
    privateKeyHex: string,
    rpcUrl: string
): Promise<string> {
    
    const connection = new Connection(rpcUrl, 'confirmed');
    const secretKey = Buffer.from(privateKeyHex, 'hex');
    const wallet = Keypair.fromSecretKey(secretKey);

    // 1. Convert SOL amount to Lamports
    const amountInLamports = Math.floor(solAmount * 1_000_000_000);

    // 2. Request the absolute best route quote from Jupiter v6
    // Using 500 BPS (5.0%) slippage tolerance for volatile meme coins
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${WSOL_MINT}&outputMint=${tokenMint}&amount=${amountInLamports}&slippageBps=500`;
    
    const quoteResponse = await fetch(quoteUrl).then(res => res.json());
    if (quoteResponse.error) {
        throw new Error(`Jupiter Routing Error: ${quoteResponse.error}`);
    }

    // 3. Request the serialized transaction payload
    const swapReq = await fetch('https://quote-api.jup.ag/v6/swap', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            quoteResponse,
            userPublicKey: wallet.publicKey.toBase58(),
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,          // Automatically calculates exact compute budget
            prioritizationFeeLamports: 150000       // 150k lamports to front-run network congestion
        })
    });
    
    const { swapTransaction, error } = await swapReq.json();
    if (error || !swapTransaction) {
        throw new Error(`Transaction Compilation Error: ${error}`);
    }

    // 4. Deserialize, Sign, and Execute
    const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
    const transaction = VersionedTransaction.deserialize(swapTransactionBuf);
    
    transaction.sign([wallet]);

    // 5. Fire directly to the RPC node (Jito relay if RPC URL is configured for it)
    const txid = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: true, // Speeds up execution by skipping local simulation
        maxRetries: 2
    });

    return txid; // Return the transaction signature for the block explorer
}