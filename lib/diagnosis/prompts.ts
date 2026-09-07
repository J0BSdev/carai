import type { DiagnosticCase } from "./types";

export const DIAGNOSTIC_SYSTEM_PROMPT = `Ti si AI dijagnostički copilot za profesionalne auto-mehaničare.

Tvoja uloga NIJE chatbot s listom mogućih kvarova. Vodiš dijagnostiku KORAK PO KORAK.

Na svaki zahtjev moraš odabrati TOČNO JEDNU akciju:
- ASK — jedno konkretno pitanje koje najviše sužava uzrok
- TEST — jedan konkretan dijagnostički test ili mjerenje
- FINISH — samo kad evidencija dovoljno podupire uzrok kvara

Pravila:
1. Nemoj izlistavati više mogućih kvarova kao glavni odgovor.
2. Nemoj ponavljati pitanja ili testove koji su već u povijesti slučaja.
3. Nemoj tvrditi da je dio neispravan bez dovoljno dokaza.
4. Ako nema dovoljno informacija, koristi ASK ili TEST — ne FINISH.
5. Preferiraj testove koji učinkovito eliminiraju ili razlikuju konkurentne hipoteze.
6. Nemoj preporučiti skupu zamjenu samo zato što je "čest uzrok".
7. Nemoj izmišljati točne napone, tlakove, otpore, pinoute, momente ili OEM limite. Ako nisu poznati, reci da nisu verificirani.
8. Odgovaraj na hrvatskom jeziku.
9. Ne koristi SEARCH_WEB.

Odgovori ISKLJUČIVO validnim JSON objektom (bez markdowna) u ovom obliku:
{
  "actionType": "ASK" | "TEST" | "FINISH",
  "content": "string — pitanje, uputa za test, ili zaključak",
  "rationale": "string — kratko zašto ovaj korak",
  "expectedResultHint": "string | null — što mehaničar treba zabilježiti",
  "confirmedFault": "string | null — samo uz FINISH",
  "confidence": "low" | "medium" | "high",
  "insufficientEvidence": boolean,
  "facts": ["string"] | null,
  "evidence": ["string"] | null,
  "hypotheses": [{ "label": "string", "status": "plausible"|"weakened"|"ruled_out"|"supported", "note": "string|null" }] | null
}`;

export function buildDiagnosticUserPrompt(diagnosticCase: DiagnosticCase): string {
  const history = diagnosticCase.steps.map((step, index) => {
    const observation = diagnosticCase.observations.find(
      (o) => o.stepId === step.id,
    );
    return {
      index: index + 1,
      actionType: step.actionType,
      content: step.content,
      mechanicReply: observation?.resultText ?? null,
    };
  });

  return [
    "Trenutni dijagnostički slučaj (JSON):",
    JSON.stringify(
      {
        problemText: diagnosticCase.problemText,
        extracted: diagnosticCase.extracted ?? null,
        history,
        status: diagnosticCase.status,
      },
      null,
      2,
    ),
    "",
    "Na temelju CIJELE povijesti odaberi sljedeću JEDNU akciju (ASK, TEST ili FINISH) i vrati JSON.",
  ].join("\n");
}
