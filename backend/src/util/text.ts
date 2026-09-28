const STOPWORDS = new Set(
  `a about above after again against all also am an and any are aren't as at be because been before being below between both
  but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few for from further get got
  had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll
  i'm i've if in into is isn't it it's its itself just let's like me more most mustn't my myself no nor not now of off on once
  only or other ought our ours ourselves out over own really same shan't she she'd she'll she's should shouldn't so some such
  than that that's the their theirs them themselves then there there's these they they'd they'll they're they've this those
  through to too under until up us very was wasn't we we'd we'll we're we've were weren't what what's when when's where where's
  which while who who's whom why why's will with won't would wouldn't you you'd you'll you're you've your yours yourself
  yourselves yes yeah ok okay pls please thanks thank lol hai hi hello bro guys one two even still much many make know think
  want need going go see say said will would well way thing things day today time new via amp http https www com
  says source main run without directly anyone ask asked since back start real every another something anything nothing
  someone everyone better best good great right left last first next still already always never ever maybe probably
  actually literally basically use using used work works working try trying tried help thing look looking looks come
  comes coming take takes make makes made give gives find found keep kept feel feels seem seems put set around
  able across along among could cant dont didnt doesnt isnt wasnt wont im ive youre thats theres whats lets gonna
  wanna gotta yet ago per etc year years week weeks month months hour hours minute minutes today tomorrow yesterday
  morning night lot lots bit little big small high low long short part end full kind sure true false free`
    .split(/\s+/)
    .filter(Boolean)
    .concat(
      // Hindi (Devanagari) function words, and the romanised Hinglish forms that fill Indian
      // feeds. Without these the "rising keywords" list on a Hindi source is "hai", "ke", "ki".
      `का के की को में है हैं था थे थी हो होगा और या पर से भी नहीं ही तो यह वह ये वो इस उस जो कि क्या कब क्यों कैसे कहां अब तक बहुत सब कुछ
       कोई हम तुम आप मैं मेरा मेरी तेरा उनका उनकी अपना अपनी लिए साथ बाद फिर बस अरे हाँ नही जी सर भाई
       hai hain ho hoga ka ke ki ko mein me se par bhi nahi nahin toh yeh yah woh wo ye vo iss uss jo kya kab kyon kyu kaise kahan
       ab tak bahut bohot sab kuch koi hum tum aap main mera meri tera teri uska uski apna apni liye saath baad phir bas arre haan
       nahi ji sir bhai yaar acha accha theek thik matlab kar karo karna kiya karte raha rahe rahi gaya gayi wala wale wali
       ஒரு இது அது என்று மற்றும் இல்லை ஆக என் உன் அவர் நான் நீ இந்த அந்த
       ഒരു ഇത് അത് എന്ന് ആണ് ഇല്ല ഞാൻ നീ അവൻ അവൾ ഈ ആ`.split(/\s+/).filter(Boolean),
    ),
);

/** Lowercased content words (3+ letters, no URLs / numbers / stopwords) plus #hashtags. */
export function tokenize(text: string): string[] {
  const clean = text.toLowerCase().replace(/https?:\/\/\S+|t\.me\/\S+|@\w+/g, " ");
  const words = clean.match(/#?[\p{L}][\p{L}\p{M}\p{N}_'-]{2,}/gu) ?? [];
  return words
    .map((w) => w.replace(/['-]+$/, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}
