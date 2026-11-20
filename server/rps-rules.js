export const RPS_CHOICES = Object.freeze(["rock", "paper", "scissors"]);

const BEATS = Object.freeze({
  rock: "scissors",
  paper: "rock",
  scissors: "paper"
});

export function isRpsChoice(value) {
  return RPS_CHOICES.includes(value);
}

/**
 * Calculates a round for two or three players.
 * Equal choices and a full three-way cycle are draws.
 */
export function resolveRpsRound(choicesByPlayer) {
  if (!choicesByPlayer || typeof choicesByPlayer !== "object" || Array.isArray(choicesByPlayer)) {
    throw new TypeError("Expected a player-choice object");
  }

  const entries = Object.entries(choicesByPlayer);
  if (entries.length < 2) {
    throw new RangeError("A round requires at least two players");
  }
  for (const [, choice] of entries) {
    if (!isRpsChoice(choice)) {
      throw new TypeError("Invalid choice");
    }
  }

  const uniqueChoices = [...new Set(entries.map(([, choice]) => choice))];
  if (uniqueChoices.length !== 2) {
    return {
      outcome: "draw",
      winningChoice: null,
      winnerIds: [],
      loserIds: [],
      choiceCount: entries.length
    };
  }

  const winningChoice = uniqueChoices.find(choice =>
    BEATS[choice] === uniqueChoices.find(other => other !== choice)
  );
  const winnerIds = entries.filter(([, choice]) => choice === winningChoice).map(([id]) => id);
  const loserIds = entries.filter(([, choice]) => choice !== winningChoice).map(([id]) => id);

  return {
    outcome: "win",
    winningChoice,
    winnerIds,
    loserIds,
    choiceCount: entries.length
  };
}
