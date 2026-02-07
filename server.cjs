#!/usr/bin/env node
/**
 * Agent Dashboard Server
 * 
 * Self-hosted dashboard for monitoring agent status:
 * - Wallet balance
 * - Trust score
 * - Recent attestations
 * - Service health
 * - DVM activity
 */

const express = require('express');
const { createWallet } = require('lightning-agent');
const { Relay } = require('nostr-tools/relay');
const { nip19 } = require('nostr-tools');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { WebSocket } = require('ws');

global.WebSocket = WebSocket;

const app = express();
const PORT = process.env.PORT || 8406;
const HISTORY_FILE = path.join(__dirname, 'history.json');

// Load/save history
function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch {
    return { wallet: [], trust: [] };
  }
}

function saveHistory(history) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

function addHistoryPoint(key, value) {
  const history = loadHistory();
  const now = Date.now();
  
  // Add new point
  if (!history[key]) history[key] = [];
  history[key].push({ timestamp: now, value });
  
  // Keep last 7 days of hourly data (168 points max)
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  history[key] = history[key].filter(p => p.timestamp > weekAgo);
  
  saveHistory(history);
}

// Load config
const CONFIG_DIR = process.env.CONFIG_DIR || path.join(__dirname, '../bitcoin');
let nostrKeys = null;
let walletConfig = null;

try {
  nostrKeys = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'nostr-keys.json'), 'utf8'));
} catch (e) {
  console.log('Warning: No Nostr keys found');
}

try {
  walletConfig = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, 'wallet-config.json'), 'utf8'));
} catch (e) {
  console.log('Warning: No wallet config found');
}

// API: Get agent identity
app.get('/api/identity', (req, res) => {
  if (!nostrKeys) {
    return res.json({ error: 'No identity configured' });
  }
  
  const npub = nip19.npubEncode(nostrKeys.publicKeyHex);
  res.json({
    name: 'Jeletor',
    pubkey: nostrKeys.publicKeyHex,
    npub,
    lightningAddress: walletConfig?.lightningAddress || 'Not configured',
  });
});

// API: Get wallet balance
app.get('/api/wallet', async (req, res) => {
  if (!walletConfig?.nwcUrl) {
    return res.json({ error: 'No wallet configured' });
  }
  
  try {
    const wallet = createWallet(walletConfig.nwcUrl);
    const balance = await wallet.getBalance();
    wallet.close();
    
    // Track balance history (throttle to once per hour)
    const history = loadHistory();
    const lastWallet = history.wallet?.[history.wallet.length - 1];
    const hourAgo = Date.now() - 60 * 60 * 1000;
    if (!lastWallet || lastWallet.timestamp < hourAgo) {
      addHistoryPoint('wallet', balance.balanceSats);
    }
    
    res.json({
      balance,
      currency: 'sats',
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API: Get historical data
app.get('/api/history', (req, res) => {
  const history = loadHistory();
  res.json(history);
});

// API: Get trust score
app.get('/api/trust', async (req, res) => {
  if (!nostrKeys) {
    return res.json({ error: 'No identity configured' });
  }
  
  try {
    const response = await fetch(`https://wot.jeletor.cc/v1/score/${nostrKeys.publicKeyHex}`);
    const data = await response.json();
    
    // Track trust history (throttle to once per hour)
    if (data.score !== undefined) {
      const history = loadHistory();
      const lastTrust = history.trust?.[history.trust.length - 1];
      const hourAgo = Date.now() - 60 * 60 * 1000;
      if (!lastTrust || lastTrust.timestamp < hourAgo) {
        addHistoryPoint('trust', data.score);
      }
    }
    
    res.json(data);
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API: Get recent attestations
app.get('/api/attestations', async (req, res) => {
  if (!nostrKeys) {
    return res.json({ error: 'No identity configured' });
  }
  
  try {
    const relay = await Relay.connect('wss://relay.damus.io');
    
    const events = await new Promise((resolve) => {
      const collected = [];
      const timeout = setTimeout(() => {
        sub.close();
        resolve(collected);
      }, 5000);
      
      const sub = relay.subscribe([
        {
          kinds: [1985],
          '#L': ['ai.wot'],
          '#p': [nostrKeys.publicKeyHex],
          limit: 20,
        },
        {
          kinds: [1985],
          '#L': ['ai.wot'],
          authors: [nostrKeys.publicKeyHex],
          limit: 20,
        }
      ], {
        onevent(event) {
          collected.push(event);
        },
        oneose() {
          clearTimeout(timeout);
          sub.close();
          resolve(collected);
        }
      });
    });
    
    relay.close();
    
    // Process events
    const attestations = events.map(e => {
      const target = e.tags.find(t => t[0] === 'p')?.[1];
      const type = e.tags.find(t => t[0] === 'l' && t[2] === 'ai.wot')?.[1];
      const comment = e.tags.find(t => t[0] === 'comment')?.[1] || '';
      
      return {
        id: e.id,
        from: e.pubkey,
        to: target,
        type,
        comment,
        timestamp: e.created_at,
        direction: e.pubkey === nostrKeys.publicKeyHex ? 'given' : 'received',
      };
    });
    
    // Sort by timestamp
    attestations.sort((a, b) => b.timestamp - a.timestamp);
    
    res.json({
      received: attestations.filter(a => a.direction === 'received'),
      given: attestations.filter(a => a.direction === 'given'),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API: Get service health
app.get('/api/services', (req, res) => {
  const services = [
    'jeletor-dvm',
    'jeletor-wot-api',
    'jeletor-wot-dvm',
    'jeletor-writing',
    'jeletor-monitor',
    'jeletor-wot-graph',
  ];
  
  const status = services.map(service => {
    try {
      const output = execSync(`systemctl --user is-active ${service}.service 2>/dev/null`, { encoding: 'utf8' }).trim();
      return { name: service, status: output, healthy: output === 'active' };
    } catch (e) {
      return { name: service, status: 'inactive', healthy: false };
    }
  });
  
  res.json(status);
});

// API: Get DVM activity (recent requests)
app.get('/api/dvm', async (req, res) => {
  if (!nostrKeys) {
    return res.json({ error: 'No identity configured' });
  }
  
  try {
    const relay = await Relay.connect('wss://relay.damus.io');
    
    const events = await new Promise((resolve) => {
      const collected = [];
      const timeout = setTimeout(() => {
        sub.close();
        resolve(collected);
      }, 5000);
      
      const sub = relay.subscribe([
        {
          kinds: [6050], // DVM results
          authors: [nostrKeys.publicKeyHex],
          limit: 10,
        }
      ], {
        onevent(event) {
          collected.push(event);
        },
        oneose() {
          clearTimeout(timeout);
          sub.close();
          resolve(collected);
        }
      });
    });
    
    relay.close();
    
    const results = events.map(e => ({
      id: e.id,
      timestamp: e.created_at,
      contentPreview: e.content.slice(0, 100) + (e.content.length > 100 ? '...' : ''),
    }));
    
    res.json({
      recentResults: results,
      count: results.length,
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// API: Full status
app.get('/api/status', async (req, res) => {
  const [identity, wallet, trust, services] = await Promise.all([
    fetch(`http://localhost:${PORT}/api/identity`).then(r => r.json()).catch(() => null),
    fetch(`http://localhost:${PORT}/api/wallet`).then(r => r.json()).catch(() => null),
    fetch(`http://localhost:${PORT}/api/trust`).then(r => r.json()).catch(() => null),
    fetch(`http://localhost:${PORT}/api/services`).then(r => r.json()).catch(() => null),
  ]);
  
  res.json({
    timestamp: new Date().toISOString(),
    identity,
    wallet,
    trust,
    services,
  });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🤖 Agent Dashboard`);
  console.log(`   http://localhost:${PORT}`);
});
