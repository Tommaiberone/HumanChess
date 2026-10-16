# SmartChess: piano

## Obiettivo
Un analizzatore per la review delle partite. Per ogni posizione critica propone tre mosse, ciascuna con una spiegazione:
1. **Migliore**: la scelta di Stockfish.
2. **Più semplice**: entro 0,4 pedoni (misurati in Win%), la mossa con cui *tu*, al tuo livello, mantieni meglio il vantaggio.
3. **Più insidiosa**: entro lo stesso margine, la mossa che rende di più contro un avversario reale del suo livello. È hope chess, ma con rischio limitato.

Vincoli: solo CPU (i7-1360P), niente addestramento di modelli, open source (AGPL), uso personale.
Utente: 1400 rapid su Chess.com, che corrispondono a circa 1700 sulla scala Maia (Lichess blitz).

## Componenti
- **Stockfish 19**: l'oracolo oggettivo.
- **Maia-3 (23M)**: probabilità delle mosse umane per una coppia di Elo, usando le ultime 8 posizioni. Su CPU impiega circa 25 ms per posizione.
- **Expectimax** in tre modalità (vedi README): nei nodi umani pesa Maia, nei nodi motore gioca Stockfish, nelle foglie valuta Stockfish.

## Fasi
- [x] **0. Setup**: uv, Python 3.12, Stockfish 19, Maia-3.
- [x] **1. MVP**: analisi di una posizione, review di PGN e Chess.com, spiegazioni da template, report HTML, test di base.
- [ ] **2. Validazione** (la fase più importante):
  - verificare su partite Lichess reali che le probabilità di errore previste da Maia corrispondano a quelle reali, soprattutto nella coda (gli errori);
  - calibrare l'Elo personale con la massima verosimiglianza delle tue mosse;
  - confrontare i risultati con profondità e parametri diversi.
- [x] **3. Spiegazioni con LLM** (Groq): i fatti e le bozze dei template vanno all'LLM, le mosse citate vengono verificate e il template resta come fallback.
  - [ ] Chat ("perché non Cxe5?") con l'LLM che interroga i motori tramite tool.
- [~] **4. Riconoscimento dei temi**. Fatto: catture, scacchi, attacchi a pezzi indifesi o di valore maggiore, sviluppo, pezzo mosso in presa. Da fare: forchette, inchiodature, struttura pedonale.
- [x] **5. Web app locale** "cozy" in stile Chess.com: elenco partite, review con barra di valutazione, grafico, precisione, icone delle mosse, momenti chiave con tre proposte, varianti e analisi di qualsiasi posizione.
  - [ ] Import da Lichess e aperture dal Lichess Opening Explorer.
  - [ ] Opzionale: Lambda AWS per analizzare in parallelo le posizioni critiche.
- [ ] **6. Prestazioni**: inferenza Maia a batch per nodo, prima passata più leggera, analisi in parallelo.

## Parametri da rivedere
- Margini: 0,6 pedoni per la più semplice (`--margin 60`) e 1 pedone per la più insidiosa (`--tricky-margin 100`). Misurati su 16 posizioni: allargare il margine aiuta solo l'insidiosa.
- Momenti chiave: fino a 5 errori (almeno 6 punti di Win% persi) e fino a 5 scelte pratiche (Win% tra 15 e 85, guadagno pratico di almeno 3 punti).
- Profondità: 18 per le mosse candidate, 12 dentro la ricerca, 14 nella prima passata.
- Una risposta conta come errore se cede almeno 10 punti di Win%.
- Nei nodi umani si esplora il 90% della probabilità, con al massimo 5 mosse.
- Orizzonte: 4 semimosse per "semplice", 2 per "insidiosa".

## Rischi
- **Calibrazione delle code di Maia.** La ricerca usa le probabilità delle mosse sbagliate: se sono stimate male, i consigli sono sbagliati.
- **Velocità.** Ogni posizione richiede 10-20 secondi, quindi la review di una partita richiede alcuni minuti.
- **Elo.** Maia-3 è addestrato sul blitz, mentre tu giochi rapid. La conversione dell'Elo è approssimativa.
