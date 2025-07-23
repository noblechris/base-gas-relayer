// api/relay.js - Vercel serverless function
import { ethers } from 'ethers';

// Base mainnet configuration
const BASE_RPC_URL = 'https://mainnet.base.org';
const RELAYER_PRIVATE_KEY = '0x38d7d9219128b21a44aa53a6d538b92d16ee1dc87c660feb2bd2f4cd57891a31';

// Initialize provider and wallet
const provider = new ethers.JsonRpcProvider(BASE_RPC_URL);
const relayerWallet = new ethers.Wallet(RELAYER_PRIVATE_KEY, provider);

export default async function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { signedTransaction, transactionType } = req.body;

    if (!signedTransaction) {
      return res.status(400).json({ error: 'Missing signed transaction' });
    }

    console.log(`Processing ${transactionType || 'unknown'} transaction type`);
    
    // Parse the signed transaction
    let parsedTx;
    try {
      parsedTx = ethers.Transaction.from(signedTransaction);
    } catch (error) {
      return res.status(400).json({ error: 'Invalid signed transaction format' });
    }

    // Verify the transaction signature
    if (!parsedTx.signature) {
      return res.status(400).json({ error: 'Transaction is not signed' });
    }

    // Get current network state
    const [gasPrice, nonce] = await Promise.all([
      provider.getFeeData(),
      provider.getTransactionCount(relayerWallet.address)
    ]);

    // Estimate gas for the transaction
    let gasEstimate;
    try {
      const txRequest = {
        to: parsedTx.to,
        value: parsedTx.value,
        data: parsedTx.data,
        from: parsedTx.from
      };
      gasEstimate = await provider.estimateGas(txRequest);
    } catch (error) {
      console.error('Gas estimation failed:', error);
      return res.status(400).json({ 
        error: 'Gas estimation failed', 
        details: error.message 
      });
    }

    // Check relayer balance
    const relayerBalance = await provider.getBalance(relayerWallet.address);
    const totalGasCost = gasEstimate * gasPrice.gasPrice;
    
    if (relayerBalance < totalGasCost) {
      return res.status(400).json({ 
        error: 'Insufficient relayer balance for gas fees',
        required: ethers.formatEther(totalGasCost),
        available: ethers.formatEther(relayerBalance)
      });
    }

    // Create new transaction with relayer as sender but preserve original logic
    const relayedTx = {
      to: parsedTx.to,
      value: parsedTx.value,
      data: parsedTx.data,
      gasLimit: gasEstimate,
      gasPrice: gasPrice.gasPrice,
      nonce: nonce,
      chainId: 8453 // Base mainnet chain ID
    };

    // Send transaction
    console.log('Submitting transaction to Base mainnet...');
    const txResponse = await relayerWallet.sendTransaction(relayedTx);
    
    console.log(`Transaction submitted: ${txResponse.hash}`);
    
    // Wait for confirmation
    const receipt = await txResponse.wait();
    
    const response = {
      success: true,
      transactionHash: txResponse.hash,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed.toString(),
      gasPaid: (receipt.gasUsed * gasPrice.gasPrice).toString(),
      gasPaidEth: ethers.formatEther(receipt.gasUsed * gasPrice.gasPrice),
      status: receipt.status === 1 ? 'Success' : 'Failed',
      relayerAddress: relayerWallet.address,
      originalSigner: parsedTx.from,
      transactionType: transactionType || 'unknown',
      timestamp: new Date().toISOString()
    };

    console.log('Transaction successful:', response);
    return res.status(200).json(response);

  } catch (error) {
    console.error('Relayer error:', error);
    return res.status(500).json({ 
      error: 'Transaction failed', 
      details: error.message,
      timestamp: new Date().toISOString()
    });
  }
}

// Helper function to detect transaction type
function detectTransactionType(data) {
  if (!data || data === '0x') return 'ETH Transfer';
  
  const methodId = data.slice(0, 10);
  
  switch (methodId) {
    case '0xa9059cbb': return 'ERC-20 Transfer';
    case '0x095ea7b3': return 'ERC-20 Approve';
    case '0x23b872dd': return 'ERC-20 TransferFrom';
    case '0xf25b3f99': return 'EIP-7702 Delegation';
    default: return 'Contract Interaction';
  }
}