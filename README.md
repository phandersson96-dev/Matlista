# Matlista

En enkel delad inköpslista som webbapp (PWA). Lägg till varor med antal, bocka av när ni beställer, och tryck "Klar med beställningen" för att rensa. Varor kan vara återkommande och läggs då tillbaka automatiskt ett visst antal dagar efter att de senast beställdes.

- Inloggning med Google, data i Firebase Firestore (gratisnivån).
- Vilka konton som har tillgång styrs av `firestore.rules`, som klistras in i Firebase-konsolen med era riktiga mejladresser.
- Publiceras med GitHub Pages direkt från `main`.

Firebase-uppgifterna läggs i `config.js`.
