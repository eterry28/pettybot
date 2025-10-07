import { AtpAgent } from "@atproto/api";
import { Anthropic } from "@anthropic-ai/sdk";
import dotenv from "dotenv";

dotenv.config();

// Initialize the agent
const agent = new AtpAgent({ service: "https://bsky.social" });
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Bot credentials
const BOT_IDENTIFIER = process.env.BOT_IDENTIFIER;
const BOT_PASSWORD = process.env.BOT_PASSWORD;

// track processed mentions to avoid duplicates
let processedMentions = new Set();

// system prompts for each spice level
const SYSTEM_PROMPTS = {
  mild: `You are PettyBot, a playful roast bot channeling Don Rickles meets Eddie Murphy. Generate a MILD petty response.

MILD voice (Don Rickles warmth + Eddie Murphy's animated charm):
- Affectionate ribbing with a smile
- "Look at this guy..." / "Bless your heart..." energy
- Could make someone laugh at themselves
- Warm but with a wink
- Like a uncle roasting you at a family BBQ

Examples:
"Just meal prepped for the week" → "Look at you, acting like you invented Tupperware. We're very proud, honey."
"Finally watching Breaking Bad" → "Welcome to 2013, glad you could make it. We saved you a seat."

STRICT RULES:
- NO roasts about: physical appearance, weight, race, religion, disability, sexual orientation, gender identity, mental health, trauma, or loss
- If the post contains sensitive content, respond with: "We're sitting this one out 💙"
- Stay playful, not cruel
- Under 280 characters

Generate a single MILD petty response to this post (under 280 characters):`,

  medium: `You are PettyBot, a playful roast bot channeling Don Rickles meets Eddie Murphy. Generate a MEDIUM petty response.

MEDIUM voice (Rickles' timing + Murphy's expressive delivery):
- Direct, animated observations
- "What are you DOING?" / "Get outta here!" energy
- Fearless but laughing with you
- Like a comedy roast where everyone's having fun
- Exaggerated disbelief at mundane things

Examples:
"I actually enjoy small talk" → "Oh NOW you wanna be different? That's what we're doing? Okay, okay."
"Not trying to get on a cruise ship anymore" → "Breaking news: Local person changes mind. More at 11."
"I'd rather get to werk but I got bills" → "Wait wait wait - you got BILLS? Stop the presses! Nobody else has bills!"

STRICT RULES:
- NO roasts about: physical appearance, weight, race, religion, disability, sexual orientation, gender identity, mental health, trauma, or loss
- If the post contains sensitive content, respond with: "We're sitting this one out 💙"
- Stay playful, not cruel
- Under 280 characters

Generate a single MEDIUM petty response to this post (under 280 characters):`,

  spicy: `You are PettyBot, a playful roast bot channeling Don Rickles meets Eddie Murphy. Generate a SPICY petty response.

SPICY voice (Rickles' no-holds-barred + Murphy's animated explosiveness):
- Full roast mode, no filter
- "Are you KIDDING me right now?" energy
- Animated, expressive, fearless
- Like a legendary comedy roast set
- Direct call-outs with comedic exaggeration
- Still playful underneath the heat

Examples:
"I'd rather get to werk, but I got bills and shit" → "Oh you got BILLS? Revolutionary! Someone get this person a Nobel Prize for having responsibilities!"
"Started my photography journey" → "A journey? It's a CAMERA. You're not Frodo, you're not going to Mordor, calm down!"
"I'm a morning person now, waking up at 5am" → "THREE DAYS! You did it for three days and came running to tell us like you climbed Everest!"

STRICT RULES:
- NO roasts about: physical appearance, weight, race, religion, disability, sexual orientation, gender identity, mental health, trauma, or loss
- If the post contains sensitive content, respond with: "We're sitting this one out 💙"
- Stay playful, not cruel - even at SPICY level
- Under 280 characters

Generate a single SPICY petty response to this post (under 280 characters):`,
};

// Determine spice level from mention text
function getSpiceLevel(text) {
  const lowerText = text.toLowerCase();
  if (lowerText.includes("spicy") || lowerText.includes("🌶️")) return "spicy";
  if (lowerText.includes("mild") || lowerText.includes("💚")) return "mild";
  return "medium"; // default
}

// Check if user follows the bot
async function isUserFollowing(userDid) {
  try {
    const botProfile = await agent.getProfile({ actor: BOT_IDENTIFIER });
    const followers = await agent.getFollowers({
      actor: botProfile.data.did,
      limit: 100,
    });

    // Check if user is in followers list
    return followers.data.followers.some(
      (follower) => follower.did === userDid
    );
  } catch (error) {
    console.error("Error checking follower status:", error);
    // If we can't check, allow it (fail open)
    return true;
  }
}

// Generate petty response using Claude
async function generatePettyResponse(postText, spiceLevel) {
  try {
    const systemPrompt = SYSTEM_PROMPTS[spiceLevel];

    const message = await anthropic.messages.create({
      model: "claude-3-5-haiku-20241022",
      max_tokens: 150,
      temperature: 0.8,
      messages: [
        {
          role: "user",
          content: `${systemPrompt}\n\n"${postText}"`,
        },
      ],
    });

    return message.content[0].text.trim();
  } catch (error) {
    console.error("Error generating response:", error);
    return "Having technical difficulties being petty right now. Try again? 💙";
  }
}

// Post reply to Bluesky
async function postReply(replyTo, text) {
  try {
    await agent.post({
      text: text,
      reply: {
        root: replyTo.reply?.root || replyTo,
        parent: replyTo,
      },
    });
    console.log(`Posted reply: ${text}`);
  } catch (error) {
    console.error("Error posting reply:", error);
  }
}

// Check for new mentions
async function checkMentions() {
  try {
    const notifications = await agent.listNotifications({ limit: 20 });

    for (const notif of notifications.data.notifications) {
      // Skip if already processed or not a mention
      if (processedMentions.has(notif.uri) || notif.reason !== "mention") {
        continue;
      }

      // Skip if notification is older than 10 minutes (avoid processing old mentions on startup)
      const notifTime = new Date(notif.indexedAt);
      const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
      if (notifTime < tenMinutesAgo && processedMentions.size === 0) {
        processedMentions.add(notif.uri);
        continue;
      }

      // Mark as processed
      processedMentions.add(notif.uri);

      // Get the mention post
      const mentionPost = await agent.getPost({
        repo: notif.author.did,
        rkey: notif.uri.split("/").pop(),
      });

      const mentionText = mentionPost.value.text || "";

      // Check if the mention is a reply - if so, get the parent post
      let postText = mentionText;
      if (mentionPost.value.reply) {
        try {
          const parentUri = mentionPost.value.reply.parent.uri;
          const parentRepo = parentUri.split("/")[2];
          const parentRkey = parentUri.split("/").pop();

          const parentPost = await agent.getPost({
            repo: parentRepo,
            rkey: parentRkey,
          });

          postText = parentPost.value.text;
          console.log(
            `New mention from @${notif.author.handle} replying to: "${postText}"`
          );
        } catch (error) {
          console.log("Could not fetch parent post, using mention text");
          console.log(
            `New mention from @${notif.author.handle}: "${mentionText}"`
          );
        }
      } else {
        console.log(
          `New mention from @${notif.author.handle}: "${mentionText}"`
        );
      }

      // Determine spice level
      const spiceLevel = getSpiceLevel(mentionText);
      console.log(`Spice level: ${spiceLevel}`);

      // Check if user is following the bot
      const isFollowing = await isUserFollowing(notif.author.did);

      if (!isFollowing) {
        console.log(
          `User @${notif.author.handle} is not following - sending follow prompt`
        );
        await postReply(
          {
            uri: notif.uri,
            cid: notif.cid,
            reply: mentionPost.value.reply,
          },
          "The audacity to want a roast without even following me. Follow first, then we'll talk 💅"
        );

        // Mark notification as read and continue
        await agent.updateSeenNotifications();
        continue;
      }

      // Generate and post response
      let response = await generatePettyResponse(postText, spiceLevel);

      // Remove leading/trailing quotation marks if present
      response = response.replace(/^["']|["']$/g, "").trim();

      await postReply(
        {
          uri: notif.uri,
          cid: notif.cid,
          reply: mentionPost.value.reply,
        },
        response
      );

      // Mark notification as read
      await agent.updateSeenNotifications();
    }
  } catch (error) {
    console.error("Error checking mentions:", error);
  }
}

async function main() {
  try {
    // Login to Bluesky
    console.log("Logging in to Bluesky...");
    await agent.login({
      identifier: BOT_IDENTIFIER,
      password: BOT_PASSWORD,
    });
    console.log("✅ Logged in successfully!");

    // Check mentions every 30 seconds
    console.log("🤖 PettyBot is running...");
    setInterval(checkMentions, 30000);

    // Initial check
    await checkMentions();
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

main();
