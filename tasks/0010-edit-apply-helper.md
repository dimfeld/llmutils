When we fail to apply some edits, the current behavior just prints errors and exits. We want to make this better.

Edits are defined by search/replace pairs. Both the diff-editor and the udiff-simple editor end up using this process
to apply the edits once they have parsed their input.

## Algorithm

Plan on edit failure:
- find the closest match
- print the diff to console if we use that closest match, mention how many lines matched
- give options using @inquirer/prompts select:
  - apply it
  - edit in neovim diff mode

Plan on "not unique error":
- Gather all the matches
- List the line numbers of each one
- Use a @inquirer/prompts select to choose which location to apply, or none. The description for each prompt item should
give additional line context.

## Implementation Plan

- Add closest match algorithm and tests in a new file under src/editors
- Create a common return type for results from udiff-simple and diff-editor. udiff-simple returns a EditHunk but we want
something in the result that includes the hunk and also the "beforeText" as original and "afterText" as updated so that it matches the Edit
from diff-editor. Add additional information about the edit as well, for example udiff-simple has a "not unique" error
which would benefit from returning all the line numbers where it found matches.
- Update udiff-simple editor to return failure results in the new format
- Update diff-editor to return failure results in the new format
- Add a new argument to applyLlmEdits to control whether or not to enter the new interactive resolution mode
- Implement the interactive resolution mode
  - In applyLlmEdits, if we get failure results, enter the new interactive resolution mode
  - In the interactive resolution mode, iterate over the errors and handle each one according to the algorithm above.

## Finding the Closest Match

We have a set of lines that are supposed to match exactly in the file, but don't.

Something like this might work

```typescript
import stringComparison from 'string-comparison';

// Interface for search and replace operation
interface SearchReplace {
  searchLines: string[];
  replaceLines: string[];
}

// Configuration for closest match
interface ClosestMatchConfig {
  similarityThreshold: number; // 0 to 1, higher means stricter matching
  maxMatches: number; // Max number of close matches to consider
  maxLineGap: number; // Max allowed gap between matching lines
}

// Find closest matches in the file
function findClosestMatches(
  fileLines: string[],
  searchLines: string[],
  config: ClosestMatchConfig
): { lines: string[]; startLine: number; endLine: number; score: number }[] {
  const results: { lines: string[]; startLine: number; endLine: number; score: number }[] = [];
  // Lookup table of lines in the file to their line numbers
  const lineToIndices = new Mao<string, number[]>();

  fileLines = fileLines.map(line => line.trimEnd());

  fileLines.forEach((line, index) => {
    const lines = lineToIndices.get(line);
    if(lines) {
      lines.push(index);
    } else {
      lineToIndices.set(line, [index]);
    }
  });

  const candidates: { indices: number[]; startLine: number; endLine: number }[] = [];
  searchLines.forEach((searchLine, searchIndex) => {
    const matches = lineToIndices[searchLine.trim()] || [];
    matches.forEach(fileIndex => {
      const matchIndices: number[] = new Array(searchLines.length).fill(-1);
      matchIndices[searchIndex] = fileIndex;
      let minLine = fileIndex;
      let maxLine = fileIndex;

      for (let i = 0; i < searchLines.length; i++) {
        if (i === searchIndex) continue;
        let bestMatchIndex = -1;
        let bestSimilarity = -1;
        const searchLineTrimmed = searchLines[i].trimEnd();

        for (
          let j = Math.max(0, fileIndex - config.maxLineGap);
          j < Math.min(fileLines.length, fileIndex + config.maxLineGap + 1);
          j++
        ) {
          if (matchIndices.includes(j)) continue;
          const similarity = searchLineTrimmed === fileLines[j].trimEnd() ? 1 : stringComparison.diceCoefficient.similarity(searchLines[i], fileLines[j]);
          if (similarity > bestSimilarity && similarity >= config.similarityThreshold / 2) {
            bestSimilarity = similarity;
            bestMatchIndex = j;
          }
        }

        if (bestMatchIndex !== -1) {
          matchIndices[i] = bestMatchIndex;
          minLine = Math.min(minLine, bestMatchIndex);
          maxLine = Math.max(maxLine, bestMatchIndex);
        }
      }

      candidates.push({
        indices: matchIndices,
        startLine: minLine,
        endLine: maxLine
      });
    });
  });

    for (const candidate of candidates) {
    const score = calculateMatchScore(searchLines, fileLines, candidate.indices);
    if (score >= config.similarityThreshold) {
      const matchLines: string[] = [];
      for (let i = 0; i < searchLines.length; i++) {
        matchLines.push(candidate.indices[i] !== -1 ? fileLines[candidate.indices[i]] : '');
      }
      results.push({
        lines: matchLines,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score
      });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, config.maxMatches);
}
```

# Opening Neovim

If the user chooses to open in neovim, we should open neovim in diff mode.

This should involve creating a temporary file with the diff applied, and opening it in neovim diff mode,
something like `nvim -d originalFile tempFile`.
