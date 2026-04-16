const fs = require('node:fs');
const path = require('node:path');

function stripWrappingQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function readQuotedValue(lines, startIndex, rawValue) {
  const quoteCharacter = rawValue[0];
  let value = rawValue;
  let index = startIndex;

  while (!value.endsWith(quoteCharacter) && index + 1 < lines.length) {
    index += 1;
    value += `\n${lines[index]}`;
  }

  return {
    nextIndex: index,
    value: stripWrappingQuotes(value),
  };
}

function readPemValue(lines, startIndex, rawValue) {
  let value = rawValue;
  let index = startIndex;

  while (
    !/^-----END [^-]+-----$/.test(lines[index].trim()) &&
    index + 1 < lines.length
  ) {
    index += 1;
    value += `\n${lines[index]}`;
  }

  return {
    nextIndex: index,
    value,
  };
}

module.exports = function loadEnv(filePath = path.resolve(process.cwd(), '.env')) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();

    if (!key || process.env[key]) {
      continue;
    }

    if (
      (rawValue.startsWith('"') && !rawValue.endsWith('"')) ||
      (rawValue.startsWith("'") && !rawValue.endsWith("'"))
    ) {
      const result = readQuotedValue(lines, index, rawValue);
      index = result.nextIndex;
      process.env[key] = result.value;
      continue;
    }

    if (/^-----BEGIN [^-]+-----$/.test(rawValue)) {
      const result = readPemValue(lines, index, rawValue);
      index = result.nextIndex;
      process.env[key] = result.value;
      continue;
    }

    process.env[key] = stripWrappingQuotes(rawValue);
  }
};
