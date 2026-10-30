# Editorial Policy

> **Status: draft for the owner's review, 2026-10-29.** This policy binds everyone who approves ErodeGlitz posts. The software enforces parts of it (verification levels, risk tiers, approval commands), but editors are responsible for every post.
> Legal references are given so editors know where the lines are. They are not legal advice. Have a lawyer review this policy before public launch.

## 1. Mission and coverage area

ErodeGlitz gives people in Erode accurate, useful, Tamil-first local news: civic notices, public services, weather, transport, local government, education, health advisories, business, culture, sport, and public-interest reporting.

**Coverage:** Erode city (Erode City Municipal Corporation) and Erode district. Draft list of taluks, to be verified against the district administration's website before the gazetteer is finalised:

| Tamil | English |
|---|---|
| ஈரோடு | Erode |
| பெருந்துறை | Perundurai |
| மொடக்குறிச்சி | Modakkurichi |
| கொடுமுடி | Kodumudi |
| கோபிசெட்டிபாளையம் | Gobichettipalayam |
| சத்தியமங்கலம் | Sathyamangalam |
| பவானி | Bhavani |
| அந்தியூர் | Anthiyur |
| தாளவாடி | Thalavadi |
| நம்பியூர் | Nambiyur |

Also in scope: well-known places inside the district, such as சென்னிமலை (Chennimalai) and பவானிசாகர் (Bhavanisagar). Towns just across a district border are out of scope unless the story directly affects Erode residents. For example, Pallipalayam and Kumarapalayam, across the Cauvery, are in Namakkal district.

State or national news is covered only when it has a concrete local effect, and the post must say what that effect is.

## 2. Core standards

1. **Accuracy.** Publish only what has been verified to the level in §4. When in doubt, wait.
2. **Attribution.** Every factual claim names its source in the caption, and the graphic carries a source credit.
3. **Fairness.** People accused of wrongdoing are described as accused, never as guilty before a court decides. Where practical, their response is sought or noted.
4. **Minimising harm.** The public's right to know is weighed against harm to victims, children, families and communities. Some details are never published (§7).
5. **Independence.** No paid news, no favours, no promotion disguised as news. Conflicts of interest are declared (§12).
6. **Transparency.** Corrections are visible. The use of AI is disclosed (§9).

The Press Council of India's *Norms of Journalistic Conduct* are a useful benchmark for questions this policy does not answer.

## 3. Sources

### Tiers

| Tier | Examples | Default use |
|---|---|---|
| **T1 official** | District administration, city corporation, police press releases, Tamil Nadu government press releases (DIPR), the electricity distribution utility's outage notices, the India Meteorological Department, the Press Information Bureau, courts' published orders | Can establish verification level V2 on its own, if fetched from the official domain |
| **T2 established publishers** | Established Tamil and English newspapers, TV news and their websites | Discovery and corroboration; facts summarised in our own words, with attribution |
| **T3 other** | Local groups, viral messages, social-media posts, reader tips | Leads only. Never published without V2 or V3 verification. |

### Rules

- A source is used by the software only after its terms of use and robots.txt have been reviewed and the review is recorded in the source registry. RSS availability alone does not grant republication rights.
- Never copy a publisher's text. Summarise facts in our own words. Short quotes are allowed only when they are newsworthy and attributed. (Facts are not protected by copyright; expression is. Indian copyright law allows fair dealing for reporting current events; when unsure, ask.)
- **Never reuse a publisher's photos or video stills.** Graphics are our own text-based designs. Photos taken by the team, or properly licensed with the licence recorded, may be added in a later phase.
- WhatsApp forwards and social-media posts are leads only.
- Text from a publisher source is never sent to an AI model unless that publisher's terms allow it.
- Credit format in the caption: `தகவல்: <source name>`. With several sources, list the most authoritative first.

The owner chose all four kinds for the first batch (2026-10-30): government announcements, power-cut and weather notices, newspapers (discovery only), and editor tips. Candidate sources to evaluate in Phase 1. Unless noted, none has been checked yet; check each one's terms, robots.txt and the feed or page format:

- Erode district administration website (press releases, announcements)
- Erode City Municipal Corporation notices
- Tamil Nadu DIPR press releases
- Electricity distribution utility planned-outage pages (Erode circle)
- India Meteorological Department and Regional Meteorological Centre, Chennai
- Press Information Bureau feeds (filtered for Erode)
- Established Tamil and English publishers' Erode or Kongu-region feeds, if their terms allow automated access
- **Dinamalar, Erode district news** (<https://www.dinamalar.com/news/tamil-nadu-district-news-erode>), nominated by the owner, discovery only. Checked 2026-10-30:
  - The page loads (HTTP 200).
  - robots.txt does not disallow `/news/` for general crawlers. It blocks OpenAI's GPTBot and also names other AI crawlers (ChatGPT-User, Google-Extended, CCBot), a clear signal against AI use. So its text must never be sent to an AI model.
  - Its sitemaps (for example `sitemap_cities.xml`) may be a lighter way to find new Erode items than fetching listing pages.
  - Its terms of use have **not** been reviewed yet. That review is required before the collector may fetch it.

## 4. Verification levels

| Level | Meaning |
|---|---|
| **V0 unverified** | One non-official source |
| **V1 corroborated** | Two or more **independent** credible sources (different organisations; syndicated copies of one report count once) |
| **V2 official** | A primary official source, fetched from the official domain or confirmed by an official on the record |
| **V3 editor-attested** | An editor verified the facts and recorded how, using `/attest` (for example, "Called the Erode South police station, 10:40 IST, spoke to the duty officer") |

**AI output never counts as verification**, however confident it sounds. AI can summarise sources and point out inconsistencies; a person decides.

Minimum level to publish:

| Risk tier (§5) | Minimum verification |
|---|---|
| R0 routine | V1, V2 or V3 |
| R1 standard | V1, V2 or V3 |
| R2 sensitive | V2 or V3 |
| Disputed | V3, and the caption must present the dispute fairly with attribution for each side |

A V0 story cannot be approved until an editor records `/attest`.

## 5. Risk tiers and sensitive categories

| Tier | Typical content |
|---|---|
| **R0 routine** | Official schedules and notices: power shutdowns, water supply, camps, admissions, exam timetables, weather advisories, traffic diversions |
| **R1 standard** | General civic news, events, business openings, sport, culture, infrastructure progress, accidents without deaths or serious injuries |
| **R2 sensitive** | Anything listed below |

R2 categories (the software flags these; editors add any it misses):

- Crime, arrests, police complaints, court cases
- Death, serious injury, suicide or self-harm
- Sexual offences, or anything involving a child as victim, accused or witness
- Caste, religion, communal tension, honour-related violence
- Elections, political parties, politicians' statements, protests, strikes
- Allegations against a named person, business or institution
- Disease outbreaks, medical claims, food safety
- Disasters and emergencies where panic or rumour is possible
- Graphic or distressing events
- Anything where sources conflict (flagged as **disputed**)

The software's tier is a floor. AI suggestions can only raise it. An editor may lower a tier only by recording a reason, for example a keyword false positive.

## 6. Human approval rules

- **Every post is approved by an editor** until the owner decides otherwise in Phase 4. Even then, only allowlisted R0 categories from T1 sources may auto-publish, with a veto window.
- R2 and disputed stories need `/approve-sensitive <rev>`. Plain `/approve` is refused.
- An approval applies to one exact revision. Any change to the caption, headline, graphic or sources creates a new revision that needs a new approval.
- Approvals expire after 12 hours (configurable). Old news gets a fresh look.
- When a second editor is available, the owner may require two approvals for the most serious R2 categories (sexual offences, children, communal incidents, deaths).
- Before approving an R2 story, the editor goes through the checklist in §14.

## 7. Legal and ethical red lines

**Never publish:**

1. **Anything that identifies a victim of a sexual offence**, including name, photo, address, school, workplace, relatives or any combination that could identify them. (Bharatiya Nyaya Sanhita, 2023, section 72, formerly IPC section 228A.)
2. **Anything that identifies a child victim or witness in a sexual-offence case.** (POCSO Act, 2012, section 23.)
3. **Anything that identifies a child in conflict with the law, or a child in need of care and protection.** (Juvenile Justice (Care and Protection of Children) Act, 2015, section 74.)
4. **Suicide method or location details, suicide notes, or sensational suicide headlines.** If suicide is reported at all, report it briefly, without speculation about causes, and include a helpline: Tele-MANAS **14416** (national mental-health helpline; confirm the number is current before use).
5. Guilt language before a court verdict. Use "accused" (குற்றம் சாட்டப்பட்டவர்) and "according to police" (காவல்துறை தகவல்படி).
6. **Caste or religion** of victims or accused, unless it is the core of the story (for example, a caste-atrocity case recorded as such by police), and then only with the owner's approval.
7. Content that could inflame communal or caste tension, or repeat hate speech, even as a quote.
8. Rumours or unverified casualty figures during emergencies. Only official numbers, attributed.
9. Speculation about pending court cases, or anything that could prejudice a trial or breach a court order.
10. Election content that breaks Election Commission restrictions, such as the silence period before polling or the exit-poll embargo. All election content is R2.
11. Private details: phone numbers, home addresses, medical information, ID documents. No photos of identifiable minors without guardian consent.
12. Graphic images of death, injury or violence.
13. Health claims not backed by an official health authority.

**Handle with extra care:** defamation risk (criminal defamation is BNS section 356; there is also civil liability). Accusations against named private people need V2 or V3 verification, attribution, and should include their side where possible.

## 8. Tamil writing style

- **Language:** clear, standard Tamil that a general reader understands. Use English terms only where readers commonly use them, and do not mix scripts within a word.
- **Headline:** at most about 60 characters, so it fits the graphic. Active voice, factual, no question-bait, no exclamation marks except official emergency alerts.
- **Body:** 2 to 5 short sentences covering what, where, when, and who said it. The most useful information goes first, for example the outage time and affected areas.
- **Attribution phrases:** `… என்று காவல்துறை தெரிவித்துள்ளது` (police said), `… என்று மாவட்ட நிர்வாகம் அறிவித்துள்ளது` (the district administration announced), `… என்று கூறப்படுகிறது` (it is reported, only together with a named source).
- **Numbers:** digits, with Tamil units where natural (for example "1.5 லட்சம்"). Dates: `29 அக்டோபர் 2026`. Times: `காலை 9 மணி முதல் மாலை 5 மணி வரை`.
- **Avoid sensational words** in headlines: பரபரப்பு, அதிர்ச்சி, வைரல், and similar.
- **Hashtags:** at most 5, from the approved list, for example `#ஈரோடு #Erode #ErodeNews #ErodeGlitz` plus one topic tag. No trending-tag stuffing.
- **Mentions:** do not @-mention private individuals. Official accounts only with the owner's approval.
- **Alt text:** describe the graphic's text and purpose in Tamil (an English line is optional).
- **Credit line:** `தகவல்: <source>`.
- **Corrections:** start with `திருத்தம்:` (correction). Updates start with `புதுப்பிப்பு:` (update).

Example structure:

```text
<Tamil headline>

<Fact 1: what happened or what is announced, where, when>
<Fact 2: key numbers, attributed>
<Fact 3: what readers should do, if anything>

தகவல்: <source>
#ஈரோடு #Erode #ErodeNews
```

## 9. Use of AI

**AI may:** draft Tamil captions from a structured fact sheet; suggest headlines; summarise and compare sources; flag possible sensitive content or inconsistencies; draft alt text.

**AI may not:** verify facts; approve, reject or schedule posts; lower a risk tier; invent quotes, numbers, names or places; produce photographs or photorealistic images for news; write about a story it has not been given facts for.

Editors are responsible for every word published, whoever or whatever drafted it. The page's bio and published policy say that drafts may be AI-assisted and that humans edit and approve every post.

## 10. Corrections, updates and takedowns

- Report errors to the owner at once, and use `/killswitch on` if more posts might repeat the error.
- **Serious error** (legal risk, identifies a protected person, could cause harm): remove the post at once. Today that means deleting it in the Instagram app; API deletion may come in Phase 4. Record it with `/retract <reason>`.
- **Material factual error:** edit the caption in the Instagram app with a `திருத்தம்:` note explaining what changed, and publish a correction post if the error was widely seen.
- **Minor error** (spelling, formatting): edit the caption; no note needed.
- Target: act within 2 hours of discovery during the posting window.
- Every correction is logged in the database and reviewed weekly.

## 11. Complaints and grievances

- A complaints contact (email or form) is published in the bio and policy page before launch.
- Acknowledge complaints within 48 hours. Record each one with the decision and action taken.
- Requests from people named in stories (for example, for removal or correction) are reviewed by the owner.
- Whether formal grievance-redressal obligations for digital news publishers (IT Rules 2021) apply to ErodeGlitz is a question for legal counsel.

## 12. Independence and conflicts of interest

- No payment, gift or favour in exchange for coverage.
- Editors do not approve stories about themselves, their relatives, their employers or businesses they hold a stake in. Someone else approves those, or the story waits.
- Sponsored content, if ever accepted, must be clearly labelled, approved by the owner, and published under Instagram's branded-content rules. It is not in scope now.

## 13. Breaking news and emergencies

- Use T1 sources, or V3 attestation, only.
- Publish what is known, attributed, and what people should do. Update as facts change; don't speculate.
- No casualty numbers unless official, and attributed.
- Include emergency helplines given by officials, after confirming the numbers.

## 14. Reviewer checklist

Copied into every review issue. Required for R2.

- [ ] Facts match the sources; every number, name, date and place has been checked
- [ ] Verification level meets the minimum for this risk tier
- [ ] Attribution appears in both caption and graphic
- [ ] No protected identity (sexual-offence victim, child, juvenile), directly or by combining details
- [ ] No guilt language before a verdict; the accused's side included where possible
- [ ] No caste or religion unless essential and approved by the owner
- [ ] No graphic content; no suicide method or location details; helpline included if relevant
- [ ] No speculation on a pending court case; no election-restriction breach
- [ ] Headline is accurate and not sensational
- [ ] Possible duplicates checked
- [ ] Tamil is correct and readable; the graphic text matches the caption
