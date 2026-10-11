const personalPatterns = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/, "an email address"],
  [/(?<![\w-])\+?\d[\d ().-]{7,}\d(?![\w-])/, "a phone number"],
  [/\b\d{3}-\d{2}-\d{4}\b/, "an ID number"],
  [/\b(date of birth|born on|d\.?o\.?b\.?)\b/i, "a date of birth"],
  [/\b\d{1,5}\s+(\w+\s+){1,3}(street|st|avenue|ave|road|rd|lane|ln|drive|dr|boulevard|blvd|court|ct|way)\b\.?/i, "a street address"],
  [/[ACGTUacgtu]{30,}/, "a DNA or RNA sequence"],
];

export function personalInformation(text) {
  return personalPatterns.flatMap(([pattern, label]) => {
    const match = text.match(pattern);
    return match && (label !== "a phone number" || (match[0].match(/\d/g) || []).length >= 9) ? [label] : [];
  });
}
