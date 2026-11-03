import express from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const PORT = Number(process.env.PORT) || 3000;
const LEGACY_STATE_FILE_PATH = path.resolve(process.cwd(), '.store-cloud-state.json');
const TMP_STATE_FILE_PATH = path.join(os.tmpdir(), 'sinarpos-cloud-state.json');

export interface SharedStoreSnapshot {
  storeSettings?: Record<string, unknown> | null;
  branches?: Record<string, unknown>[];
  staffList?: Record<string, unknown>[];
  products?: Record<string, unknown>[];
  customCategories?: unknown[];
  transactions?: Record<string, unknown>[];
  expenses?: Record<string, unknown>[];
  customers?: Record<string, unknown>[];
  stockTransfers?: unknown[];
  zakatRecords?: unknown[];
  activityLogs?: unknown[];
}

interface PersistedEnvelope {
  revision: number;
  updatedAt: string;
  lastClientId: string;
  contentHash: string;
  state: SharedStoreSnapshot | null;
}

function sanitizeSettingsForHash(
  settings: Record<string, unknown> | null | undefined
): Record<string, unknown> | null {
  if (!settings || typeof settings !== 'object') return null;
  const copy: Record<string, unknown> = { ...settings };
  delete copy.lastSheetSyncAt;
  delete copy.lastFirestoreSyncAt;
  return copy;
}

function sanitizeProductsForStorage(
  products: unknown[] | undefined
): Record<string, unknown>[] {
  if (!Array.isArray(products)) return [];
  return products.map((item) => {
    if (!item || typeof item !== 'object') return {};
    const p = item as Record<string, unknown>;
    const img = typeof p.image === 'string' ? p.image : '';
    if (img.startsWith('data:image/svg+xml')) {
      const copy: Record<string, unknown> = { ...p };
      delete copy.image;
      return copy;
    }
    return p;
  });
}

function sanitizeSnapshot(
  state: SharedStoreSnapshot | null | undefined
): SharedStoreSnapshot {
  if (!state || typeof state !== 'object') {
    return {};
  }
  return {
    storeSettings: state.storeSettings || null,
    branches: Array.isArray(state.branches) ? state.branches : [],
    staffList: Array.isArray(state.staffList) ? state.staffList : [],
    products: sanitizeProductsForStorage(state.products),
    customCategories: Array.isArray(state.customCategories) ? state.customCategories : [],
    transactions: Array.isArray(state.transactions) ? state.transactions : [],
    expenses: Array.isArray(state.expenses) ? state.expenses : [],
    customers: Array.isArray(state.customers) ? state.customers : [],
    stockTransfers: Array.isArray(state.stockTransfers) ? state.stockTransfers.slice(0, 100) : [],
    zakatRecords: Array.isArray(state.zakatRecords) ? state.zakatRecords : [],
    activityLogs: Array.isArray(state.activityLogs) ? state.activityLogs.slice(0, 40) : [],
  };
}

function computeSnapshotHash(state: SharedStoreSnapshot | null | undefined): string {
  if (!state || typeof state !== 'object') return '';
  try {
    const normalized = {
      storeSettings: sanitizeSettingsForHash(state.storeSettings),
      branches: state.branches || [],
      staffList: state.staffList || [],
      products: sanitizeProductsForStorage(state.products).map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        category: p.category,
        costPrice: p.costPrice,
        sellingPrice: p.sellingPrice,
        stockByBranch: p.stockByBranch,
        availableBranchIds: p.availableBranchIds,
      })),
      customCategories: state.customCategories || [],
      transactions: (state.transactions || []).map((t) => ({
        id: t.id,
        status: t.status,
        amountPaid: t.amountPaid,
        tempoStatus: t.tempoStatus,
        tempoPaymentsCount: Array.isArray(t.tempoPayments) ? t.tempoPayments.length : 0,
      })),
      expenses: (state.expenses || []).map((e) => ({
        id: e.id,
        amount: e.amount,
        title: e.title,
      })),
      customers: (state.customers || []).map((c) => ({
        id: c.id,
        loyaltyPoints: c.loyaltyPoints,
        totalSpent: c.totalSpent,
      })),
      stockTransfersCount: Array.isArray(state.stockTransfers) ? state.stockTransfers.length : 0,
      zakatRecordsCount: Array.isArray(state.zakatRecords) ? state.zakatRecords.length : 0,
    };
    return crypto.createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
  } catch {
    return '';
  }
}

function isCustomizedStoreSnapshot(
  state: SharedStoreSnapshot | null | undefined
): boolean {
  if (!state || typeof state !== 'object') return false;
  const branches = Array.isArray(state.branches) ? state.branches : [];
  const staffList = Array.isArray(state.staffList) ? state.staffList : [];
  const products = Array.isArray(state.products) ? state.products : [];
  const transactions = Array.isArray(state.transactions) ? state.transactions : [];
  const customCategories = Array.isArray(state.customCategories) ? state.customCategories : [];

  if (branches.length > 1) return true;
  if (staffList.length > 1) return true;
  if (products.length > 0) return true;
  if (transactions.length > 0) return true;
  if (customCategories.length > 0) return true;

  if (staffList.length === 1) {
    const firstStaff = staffList[0];
    if (
      firstStaff &&
      ((typeof firstStaff.email === 'string' && firstStaff.email !== 'owner@toko.id') ||
        (typeof firstStaff.name === 'string' && firstStaff.name !== 'Pemilik Toko (Owner)') ||
        (typeof firstStaff.pin === 'string' && firstStaff.pin !== '1111'))
    ) {
      return true;
    }
  }

  return false;
}

let currentEnvelope: PersistedEnvelope = {
  revision: 0,
  updatedAt: new Date(0).toISOString(),
  lastClientId: '',
  contentHash: '',
  state: null,
};

function loadInitialDiskState(): void {
  const candidates = [TMP_STATE_FILE_PATH, LEGACY_STATE_FILE_PATH];
  for (const filePath of candidates) {
    try {
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(raw) as PersistedEnvelope;
        if (parsed && typeof parsed === 'object' && parsed.state) {
          const cleanState = sanitizeSnapshot(parsed.state);
          currentEnvelope = {
            revision: Number(parsed.revision) || 1,
            updatedAt: String(parsed.updatedAt || new Date().toISOString()),
            lastClientId: String(parsed.lastClientId || ''),
            contentHash: computeSnapshotHash(cleanState),
            state: cleanState,
          };
          break;
        }
      }
    } catch (err) {
      console.warn(`Could not load initial state from ${filePath}:`, err);
    }
  }
}

let saveDiskTimeout: ReturnType<typeof setTimeout> | null = null;
function saveDiskState(): void {
  if (saveDiskTimeout) clearTimeout(saveDiskTimeout);
  saveDiskTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(TMP_STATE_FILE_PATH, JSON.stringify(currentEnvelope), 'utf-8');
    } catch (err) {
      console.warn('Could not persist state to tmp:', err);
    }
  }, 1000);
}

loadInitialDiskState();

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  app.get('/api/store/state', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const sinceRevision = Number(req.query.sinceRevision || 0);
    if (sinceRevision > 0 && sinceRevision >= currentEnvelope.revision) {
      res.json({
        hasState: Boolean(currentEnvelope.state),
        changed: false,
        revision: currentEnvelope.revision,
        updatedAt: currentEnvelope.updatedAt,
        lastClientId: currentEnvelope.lastClientId,
      });
      return;
    }

    res.json({
      hasState: Boolean(currentEnvelope.state),
      changed: true,
      revision: currentEnvelope.revision,
      updatedAt: currentEnvelope.updatedAt,
      lastClientId: currentEnvelope.lastClientId,
      state: currentEnvelope.state,
    });
  });

  app.post('/api/store/state', (req, res) => {
    const body = req.body as {
      clientId?: string;
      forceReplace?: boolean;
      state?: SharedStoreSnapshot;
    };

    if (!body || !body.state || typeof body.state !== 'object') {
      res.status(400).json({ error: 'Invalid state payload' });
      return;
    }

    const incoming = sanitizeSnapshot(body.state);
    const prev: SharedStoreSnapshot = currentEnvelope.state || {};

    if (
      !body.forceReplace &&
      isCustomizedStoreSnapshot(currentEnvelope.state) &&
      !isCustomizedStoreSnapshot(incoming)
    ) {
      res.json({
        ok: true,
        ignoredDefaultOverwrite: true,
        revision: currentEnvelope.revision,
        updatedAt: currentEnvelope.updatedAt,
      });
      return;
    }

    const nextState: SharedStoreSnapshot = body.forceReplace
      ? {
          storeSettings: incoming.storeSettings ?? prev.storeSettings,
          branches: Array.isArray(incoming.branches) ? incoming.branches : prev.branches,
          staffList: Array.isArray(incoming.staffList) ? incoming.staffList : prev.staffList,
          products: Array.isArray(incoming.products) ? incoming.products : [],
          customCategories: Array.isArray(incoming.customCategories)
            ? incoming.customCategories
            : prev.customCategories || [],
          transactions: Array.isArray(incoming.transactions) ? incoming.transactions : [],
          expenses: Array.isArray(incoming.expenses) ? incoming.expenses : [],
          customers: Array.isArray(incoming.customers) ? incoming.customers : [],
          stockTransfers: Array.isArray(incoming.stockTransfers) ? incoming.stockTransfers : [],
          zakatRecords: Array.isArray(incoming.zakatRecords) ? incoming.zakatRecords : [],
          activityLogs: Array.isArray(incoming.activityLogs) ? incoming.activityLogs : [],
        }
      : {
          storeSettings: incoming.storeSettings
            ? { ...(prev.storeSettings || {}), ...incoming.storeSettings }
            : prev.storeSettings,
          branches: Array.isArray(incoming.branches) ? incoming.branches : prev.branches,
          staffList: Array.isArray(incoming.staffList) ? incoming.staffList : prev.staffList,
          products: Array.isArray(incoming.products) ? incoming.products : prev.products,
          customCategories: Array.isArray(incoming.customCategories)
            ? incoming.customCategories
            : prev.customCategories,
          transactions: Array.isArray(incoming.transactions)
            ? incoming.transactions
            : prev.transactions,
          expenses: Array.isArray(incoming.expenses) ? incoming.expenses : prev.expenses,
          customers: Array.isArray(incoming.customers) ? incoming.customers : prev.customers,
          stockTransfers: Array.isArray(incoming.stockTransfers)
            ? incoming.stockTransfers
            : prev.stockTransfers,
          zakatRecords: Array.isArray(incoming.zakatRecords)
            ? incoming.zakatRecords
            : prev.zakatRecords,
          activityLogs: Array.isArray(incoming.activityLogs)
            ? incoming.activityLogs
            : prev.activityLogs,
        };

    const nextHash = computeSnapshotHash(nextState);
    if (!body.forceReplace && nextHash && nextHash === currentEnvelope.contentHash) {
      res.json({
        ok: true,
        unchanged: true,
        revision: currentEnvelope.revision,
        updatedAt: currentEnvelope.updatedAt,
      });
      return;
    }

    currentEnvelope = {
      revision: currentEnvelope.revision + 1,
      updatedAt: new Date().toISOString(),
      lastClientId: String(body.clientId || ''),
      contentHash: nextHash,
      state: nextState,
    };

    saveDiskState();

    res.json({
      ok: true,
      revision: currentEnvelope.revision,
      updatedAt: currentEnvelope.updatedAt,
    });
  });

  app.get('/api/store/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const heartbeat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(heartbeat);
      }
    }, 45000);

    req.on('close', () => {
      clearInterval(heartbeat);
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SinarPOS Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
