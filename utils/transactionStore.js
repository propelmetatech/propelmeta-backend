const fs = require('node:fs');
const path = require('node:path');

function cloneValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

class TransactionStore {
  constructor(filePath) {
    if (!filePath) {
      throw new Error('Transaction store file path is required.');
    }

    this.filePath = path.resolve(filePath);
    this.transactions = new Map();

    this.ensureStorageDirectory();
    this.loadFromDisk();
  }

  ensureStorageDirectory() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
  }

  loadFromDisk() {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(
          {
            version: 1,
            updatedAt: new Date().toISOString(),
            transactions: [],
          },
          null,
          2,
        ),
        'utf8',
      );
      return;
    }

    const fileContents = fs.readFileSync(this.filePath, 'utf8').trim();
    if (!fileContents) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(fileContents);
    } catch (error) {
      throw new Error(
        `Unable to parse transaction store at ${this.filePath}: ${error.message}`,
      );
    }
    const records = Array.isArray(parsed?.transactions)
      ? parsed.transactions
      : Array.isArray(parsed)
        ? parsed
        : [];

    for (const record of records) {
      if (!record?.merchantTxnId) {
        continue;
      }

      this.transactions.set(record.merchantTxnId, record);
    }
  }

  persist() {
    const tempPath = `${this.filePath}.tmp`;
    const records = Array.from(this.transactions.values());
    const payload = {
      version: 1,
      updatedAt: new Date().toISOString(),
      transactions: records,
    };

    fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tempPath, this.filePath);
  }

  get(merchantTxnId) {
    if (!merchantTxnId) {
      return null;
    }

    const record = this.transactions.get(String(merchantTxnId));
    return record ? cloneValue(record) : null;
  }

  upsert(record) {
    if (!record?.merchantTxnId) {
      throw new Error('merchantTxnId is required to store a transaction.');
    }

    const merchantTxnId = String(record.merchantTxnId);
    const previous = this.transactions.get(merchantTxnId) || {};
    const nextRecord = {
      ...previous,
      ...cloneValue(record),
      merchantTxnId,
    };

    this.transactions.set(merchantTxnId, nextRecord);
    this.persist();
    return cloneValue(nextRecord);
  }

  size() {
    return this.transactions.size;
  }
}

module.exports = {
  TransactionStore,
};
