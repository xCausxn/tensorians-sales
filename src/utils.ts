export function roundToDecimal(num: number, decimal = 2) {
  const factor = Math.pow(10, decimal);
  return Math.round(num * factor) / factor;
}

export function smartTruncate(str: string, countBothSides = 4) {
  if (str.length <= countBothSides * 2) {
    return str;
  }
  const start = str.slice(0, countBothSides);
  const end = str.slice(-countBothSides);
  return `${start}...${end}`;
}
