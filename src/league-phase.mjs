const QUIET=new Set(['None','Lobby','EndOfGame','TerminatedInError','FailedToLaunch']);

// WaitingForStats/PreEndOfGame can arrive before the game process exits. '' means no
// client was found.
export function clientPhaseQuiet(phase){return phase===''||QUIET.has(phase);}
