// index.js

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, REST } = require('discord.js');
const { Routes } = require('discord-api-types/v10');
const { format } = require('date-fns');
const axios = require('axios');
const { spawn } = require('child_process'); // Added for running child processes
require('dotenv').config();

const logsFolder = './logs';
let currentLogFile;
const botLogQueue = [];
const siteLogQueue = [];
let isProcessingBotLogQueue = false;
let isProcessingSiteLogQueue = false;

// Webhook URLs from .env
const webhookURL = process.env.WEBHOOK_URL;
const sharedSiteWebhookURL = process.env.SITE_WEBHOOK_URL;

// Shared site webhook URL and queue
const siteWebhookQueue = [];

// Function to create a new log file with timestamp as the name
function createLogFile() {
  const timestamp = format(new Date(), 'yyyy-MM-dd_HH-mm-ss');
  currentLogFile = path.join(logsFolder, `${timestamp}.log`);
  fs.writeFileSync(currentLogFile, `Log started at: ${timestamp}\n\n`);
}

// Function to log messages to the console, current log file, and bot webhook queue
async function log(message, isSiteRelated = false) {
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
  const formattedMessage = `[${timestamp}] ${message}`;

  console.log(formattedMessage);
  fs.appendFileSync(currentLogFile, `${formattedMessage}\n`);

  // Log to bot webhook queue
  if (!isSiteRelated && webhookURL) {
    botLogQueue.push(formattedMessage);
    if (!isProcessingBotLogQueue) {
      processBotLogQueue();
    }
  }

  // Log to site webhook queue
  if (isSiteRelated && sharedSiteWebhookURL) {
    siteWebhookQueue.push(formattedMessage);
    if (!isProcessingSiteLogQueue) {
      processSiteLogQueue();
    }
  }
}

// Function to process the bot-related log queue and send logs to the webhook
async function processBotLogQueue() {
  isProcessingBotLogQueue = true;

  // Wait for a brief period to collect more logs
  await new Promise(resolve => setTimeout(resolve, 500));

  if (botLogQueue.length > 0) {
    const logs = botLogQueue.join('\n');
    botLogQueue.length = 0; // Clear the queue
    try {
      await axios.post(webhookURL, { content: logs });
      console.log('Logged to bot webhook successfully.');
    } catch (webhookError) {
      handleWebhookError(webhookError, botLogQueue, processBotLogQueue);
    }
  }

  isProcessingBotLogQueue = false;
}

// Function to process the site-related log queue and send logs to the webhook
async function processSiteLogQueue() {
  isProcessingSiteLogQueue = true;

  // Wait for a brief period to collect more logs
  await new Promise(resolve => setTimeout(resolve, 500));

  if (siteWebhookQueue.length > 0) {
    const logs = siteWebhookQueue.join('\n');
    siteWebhookQueue.length = 0; // Clear the queue
    try {
      await axios.post(sharedSiteWebhookURL, { content: logs });
      console.log('Logged to site webhook successfully.');
    } catch (webhookError) {
      handleWebhookError(webhookError, siteWebhookQueue, processSiteLogQueue);
    }
  }

  isProcessingSiteLogQueue = false;
}

// Handle webhook error and retry mechanism
function handleWebhookError(webhookError, logQueue, processLogQueue) {
  if (webhookError.response && webhookError.response.status === 429) {
    // Retry after a delay (e.g., 5 seconds)
    console.log('Rate limited. Retrying after 5 seconds...');
    setTimeout(() => {
      processLogQueue();
    }, 5000);
  } else {
    console.error(`Error logging to webhook: ${webhookError.message}`);
  }
}

// Initialize logs folder if it does not exist
if (!fs.existsSync(logsFolder)) {
  fs.mkdirSync(logsFolder);
}

// Initialize a new log file on startup
createLogFile();

// Export shared site webhook URL and queue
module.exports = {
  sharedSiteWebhookURL,
  siteWebhookQueue,
};

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const commands = [];

client.once('ready', async () => {
  try {
    log(`Logged in as ${client.user.tag}`);
    
    // Load slash commands
    loadCommands();

    // Refresh slash commands across all guilds
    await refreshSlashCommands();

    // Run serve.js as a child process
    startSiteServer();
  } catch (error) {
    log(`Error during startup: ${error}`);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  try {
    // Handle each command separately
    if (commandName === 'ping') {
      await require('./commands/ping').execute(interaction, log);
    } else if (commandName === 'hello') {
      await require('./commands/hello').execute(interaction, log);
    } else if (commandName === 'help') {
      await require('./commands/help').execute(interaction, log);
    } else if (commandName === 'info') {
      await require('./commands/info').execute(interaction, log);
    }

  } catch (error) {
    log(`Error handling command "${commandName}": ${error}`);
    await interaction.reply('An error occurred while processing the command.');
  }
});

client.login(process.env.TOKEN);

async function loadCommands() {
  try {
    // Check if the commands folder exists
    const commandsFolder = './commands';
    if (!fs.existsSync(commandsFolder)) {
      throw new Error('Commands folder not found.');
    }

    // Read each file in the commands folder and load the commands
    const commandFiles = fs.readdirSync(commandsFolder).filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
      try {
        const command = require(`./commands/${file}`);
        if (typeof command.setup === 'function') {
          command.setup(client, log);
          log(`Command ${file} loaded successfully.`);
        } else {
          log(`Invalid command structure in ${file}.`);
        }

        // Collect command data for global update
        commands.push(command.data);
      } catch (error) {
        log(`Error loading command from ${file}: ${error}`);
      }
    }
  } catch (error) {
    log(`Error during command loading: ${error}`);
  }
}

async function refreshSlashCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

  try {
    log('Started refreshing global (/) commands.');

    // Fetch application (bot) information
    const application = await client.application?.fetch();
    
    // Update global slash commands
    await rest.put(
      Routes.applicationCommands(application.id),
      { body: commands },
    );

    log('Successfully reloaded global (/) commands.');
  } catch (error) {
    log(`Error refreshing global (/) commands: ${error}`);
  }
}

// Function to run serve.js as a child process
function startSiteServer() {
  const siteServerProcess = spawn('node', ['site/serve.js']);

  siteServerProcess.stdout.on('data', (data) => {
    console.log(`Site Server stdout: ${data}`);
  });

  siteServerProcess.stderr.on('data', (data) => {
    console.error(`Site Server stderr: ${data}`);
  });

  siteServerProcess.on('close', (code) => {
    console.log(`Site Server process exited with code ${code}`);
  });
}
