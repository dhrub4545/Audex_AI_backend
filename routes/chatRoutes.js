const express = require('express');
const router = express.Router();
const Chat = require('../models/Chat');
const Audit = require('../models/Audit');
const { auth, optionalAuth } = require('../middleware/auth');
const { searchWeb } = require('../services/webSearch');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// Route: Get chat history for a specific audit
router.get('/:auditId', optionalAuth, async (req, res) => {
  try {
    const { auditId } = req.params;
    const isSampleAudit = auditId === '6a4fb719471a97ae89e88f49';
    if (!isSampleAudit && !req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    
    // Find chat associated with audit
    let chat = await Chat.findOne({ auditId });
    if (!chat) {
      // Create a default welcome chat if none exists
      chat = new Chat({
        auditId,
        userId: req.user ? req.user.id : null,
        messages: [
          {
            sender: 'ai',
            text: 'Hello! I am your Audex AI Optimization Assistant. I have analyzed your subscription and API spend audit report. Feel free to ask me anything about the recommendations, migration steps, or compare different AI model tiers!',
            modelUsed: 'system'
          }
        ]
      });
      await chat.save();
    }
    
    res.json(chat);
  } catch (error) {
    console.error('Failed to get chat history:', error);
    res.status(500).json({ error: 'Failed to retrieve chat history.' });
  }
});

// Route: Send a message to the chat
router.post('/:auditId', optionalAuth, async (req, res) => {
  try {
    const { auditId } = req.params;
    const { message, model, webSearchEnabled } = req.body;
    
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message content is required.' });
    }

    const isSampleAudit = auditId === '6a4fb719471a97ae89e88f49';
    if (!isSampleAudit && !req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    
    // 1. Fetch audit context
    const audit = await Audit.findById(auditId);
    if (!audit) {
      return res.status(404).json({ error: 'Audit report not found.' });
    }
    
    // 2. Perform web search if toggled
    let searchResults = [];
    if (webSearchEnabled) {
      console.log(`[Web Search] Querying Yahoo for: "${message}"`);
      searchResults = await searchWeb(message);
    }
    
    // 3. Retrieve or create chat session
    let chat = await Chat.findOne({ auditId });
    if (!chat) {
      chat = new Chat({
        auditId,
        userId: req.user ? req.user.id : null,
        messages: []
      });
    }
    
    // Push user message to chat history
    chat.messages.push({
      sender: 'user',
      text: message,
      modelUsed: model,
      sources: searchResults
    });
    
    // 4. Load overall.json model rankings & stats
    let modelReferenceText = '';
    try {
      const overallPath = path.join(__dirname, '../data/rank/overall.json');
      if (fs.existsSync(overallPath)) {
        const overallModels = JSON.parse(fs.readFileSync(overallPath, 'utf8'));
        
        // Extract model keys involved in this audit
        const modelKeysToFind = new Set();
        (audit.allocations || []).forEach(alloc => {
          if (alloc.modelId) modelKeysToFind.add(alloc.modelId);
          if (alloc.baselineModelId) modelKeysToFind.add(alloc.baselineModelId);
          if (alloc.baselineModels) {
            alloc.baselineModels.forEach(m => modelKeysToFind.add(m));
          }
        });

        (audit.savings?.recommendations || []).forEach(rec => {
          if (rec.apiOption?.modelId) modelKeysToFind.add(rec.apiOption.modelId);
          if (rec.apiOption?.recommendedModel) modelKeysToFind.add(rec.apiOption.recommendedModel);
          if (rec.apiOption?.includedModels) {
            rec.apiOption.includedModels.forEach(m => modelKeysToFind.add(m));
          }
          if (rec.subscriptionOption?.modelId) modelKeysToFind.add(rec.subscriptionOption.modelId);
          if (rec.subscriptionOption?.recommendedModel) modelKeysToFind.add(rec.subscriptionOption.recommendedModel);
          if (rec.subscriptionOption?.includedModels) {
            rec.subscriptionOption.includedModels.forEach(m => modelKeysToFind.add(m));
          }
          if (rec.originalAlloc?.modelId) modelKeysToFind.add(rec.originalAlloc.modelId);
        });

        // Search overall.json for matches
        const matchedModels = [];
        overallModels.forEach(item => {
          const isMatch = [...modelKeysToFind].some(key => {
            if (!key) return false;
            const lowerKey = key.toLowerCase();
            return (
              (item.id && item.id.toLowerCase() === lowerKey) ||
              (item.slug && item.slug.toLowerCase() === lowerKey) ||
              (item.model_name && item.model_name.toLowerCase() === lowerKey) ||
              (item.model_key && item.model_key.toLowerCase() === lowerKey) ||
              (item.name && item.name.toLowerCase() === lowerKey) ||
              lowerKey.includes(item.model_name?.toLowerCase() || '___') ||
              lowerKey.includes(item.slug?.toLowerCase() || '___')
            );
          });
          if (isMatch) {
            matchedModels.push(item);
          }
        });

        if (matchedModels.length > 0) {
          modelReferenceText = matchedModels.map((m, idx) => {
            const pricing = m.pricing ? `Pricing: $${m.pricing.price_1m_input_tokens || 0}/1M input, $${m.pricing.price_1m_output_tokens || 0}/1M output` : 'Pricing: N/A';
            const elo = m.arena_elo ? `Arena ELO: ${m.arena_elo} (Rank #${m.arena_rank || 'N/A'})` : 'ELO: N/A';
            const finalScore = m.final_score ? `Quality Score: ${m.final_score}%` : '';
            const codingIdx = m.evaluations?.artificial_analysis_coding_index ? `Coding Index: ${m.evaluations.artificial_analysis_coding_index}` : '';
            const intelIdx = m.evaluations?.artificial_analysis_intelligence_index ? `Intelligence Index: ${m.evaluations.artificial_analysis_intelligence_index}` : '';
            return `${idx + 1}. ${m.name} (${m.organization || 'Unknown'}):
   - ELO/Rank: ${elo} | ${finalScore}
   - ${pricing}
   - Indexes: ${intelIdx} | ${codingIdx}`;
          }).join('\n\n');
        }
      }
    } catch (err) {
      console.warn("[Reference Sync Warning] Failed to compile model specifications: ", err.message);
    }

    // Map audit settings & goal definition
    const activeGoal = audit.optimizationGoal || 'performance';
    const goalDetails = {
      performance: 'Performance Preservation Mode (Recommends equal or better performance options while keeping costs equal or lower. Cost is a primary constraint; we preserve capability without increasing spend. It does NOT suggest more expensive options.)',
      cost: 'Cost Cutting Focused (Prioritizes maximum budget savings, recommending the cheapest models that meet basic criteria, allowing capability tradeoffs.)',
      quality: 'Quality Focus (Prioritizes maximum AI capability. Recommends the absolute highest-performing models and subscriptions, regardless of cost.)'
    };

    const systemPrompt = `You are Audex AI, a premium AI Spend Auditor and Cost Optimization Specialist.
You are helping the user analyze their AI subscriptions and API integration audit report.

Here are the details of the Audit Report:
- Team Size: ${audit.teamSize || 'N/A'} seats
- Use Case: ${audit.useCase || 'General'}
- Current Monthly AI Cost: $${(audit.totalCurrentCost || 0).toLocaleString()}
- Projected Monthly Savings: $${(audit.savings?.totalMonthly || 0).toLocaleString()}
- Projected Annual Savings: $${(audit.savings?.totalAnnual || 0).toLocaleString()}

Audit Settings & Active Mode:
- Selected Audit Mode: "${activeGoal === 'performance' ? 'PERFORMANCE PRESERVATION MODE' : activeGoal === 'quality' ? 'QUALITY FOCUS' : 'COST CUTTING FOCUSED'}"
- Mode Description & Features: ${goalDetails[activeGoal] || 'N/A'}
- Custom Target Cost Reduction: ${audit.costCutPercentage || 50}%

Audited Allocations (Local AI Setup):
${(audit.allocations || []).map((a, i) => `${i+1}. ${a.toolName} (${a.type}): Plan "${a.plan || 'Standard'}", ${a.seats || 1} seats, Purpose: ${a.purpose}, Current Cost: $${(a.currentCost || 0).toLocaleString()}/mo`).join('\n')}

Cost Optimization Recommendations:
${(audit.savings?.recommendations || []).map((r, i) => `${i+1}. Tool: ${r.tool}
   - Issue: ${r.issue}
   - Action: ${r.action}
   - Expected Savings: $${(r.monthlySavings || 0).toLocaleString()}/mo`).join('\n')}

${modelReferenceText ? `Audited & Recommended Model Specifications (from overall.json reference):
${modelReferenceText}` : ''}

${searchResults.length > 0 ? `Here are the latest live Web Search Results for real-time pricing and capabilities (grounded data):
${searchResults.map((r, idx) => `[Source ${idx + 1}] Title: ${r.title}
   URL: ${r.url}
   Snippet: ${r.snippet}`).join('\n\n')}` : ''}

INSTRUCTIONS:
1. Provide highly precise, professional, and actionable cost-reduction guidance based on the audit.
2. Refer directly to the provided model specifications (such as Arena ELO rank, intelligence index, coding index, and exact token pricing) when comparing models or explaining recommendations.
3. Align your suggestions and explanations with the three available optimization goals. Adhere strictly to these definitions:
   - "Performance Preservation Mode" (performance): Aims to provide equal or better model performance (recommending equal or higher ELO/rank capabilities) while reducing or keeping the cost unchanged. Recommends cheaper or equal-cost options of equal/higher quality, and does NOT recommend more expensive options. Cost is NOT secondary; we preserve capability without increasing spend.
   - "Cost Cutting Focused" (cost): Prioritizes maximum budget savings, recommending the cheapest models that meet basic criteria (allowing capability tradeoffs).
   - "Quality Focus" (quality): Prioritizes maximum AI capability. Recommends the absolute highest-performing models and subscriptions for the workload, regardless of cost.
4. Be friendly, clean, concise, and focus heavily on financial optimization, subscription vs API trade-offs, and ROI.
5. If referring to web search results, reference the URLs or titles directly (e.g. "According to Google AI documentation...").
6. Keep markdown formatting neat, readable, and structured.`;

    // Gather past messages (excluding the last welcome system message if necessary, let's keep all messages for context)
    const contextMessages = chat.messages.map(msg => ({
      role: msg.sender === 'user' ? 'user' : 'assistant',
      content: msg.text
    }));
    
    // 5. Define Fallback Chain: Always Gemini -> Grok -> Mistral -> OpenRouter -> Groq
    const fallbackChain = ['gemini', 'grok', 'mistral', 'openrouter', 'groq'];
    
    let aiResponseText = '';
    let successfulModel = '';
    let apiErrorLogs = [];
    
    for (const currentModel of fallbackChain) {
      try {
        console.log(`[Chat API] Attempting to call model: ${currentModel}`);
        
        if (currentModel === 'gemini') {
          const key = process.env.Gemini_Api_key || process.env.GEMINI_API_KEY;
          if (!key) throw new Error('Gemini API key is not configured.');
          
          // Map chat history to Gemini's content format
          const contents = chat.messages.map(msg => ({
            role: msg.sender === 'user' ? 'user' : 'model',
            parts: [{ text: msg.text }]
          }));
          
          // Append System Instruction in prompt or body
          const bodyPayload = {
            contents,
            systemInstruction: {
              parts: [{ text: systemPrompt }]
            }
          };
          
          let geminiResponse;
          try {
            console.log(`[Gemini API] Attempting to call flagship model: gemini-3.5-flash`);
            geminiResponse = await axios.post(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`,
              bodyPayload,
              { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
            );
          } catch (geminiErr) {
            console.warn(`[Gemini API Warning] Flagship gemini-3.5-flash failed: ${geminiErr.message}. Attempting sub-fallback to gemini-2.5-flash...`);
            geminiResponse = await axios.post(
              `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
              bodyPayload,
              { headers: { 'Content-Type': 'application/json' }, timeout: 15000 }
            );
          }
          
          const text = geminiResponse.data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (!text) {
            throw new Error('Gemini API returned an empty response structure.');
          }
          
          aiResponseText = text;
          successfulModel = 'gemini';
          break; // Success! Exit fallback loop.
          
        } else if (currentModel === 'grok') {
          const key = process.env.GROK_API_KEY;
          if (!key) throw new Error('Grok/xAI API key is not configured.');
          
          // xAI compatible endpoint
          const messages = [
            { role: 'system', content: systemPrompt },
            ...contextMessages
          ];
          
          let groqResponse;
          try {
            console.log(`[xAI API] Attempting to call flagship model: grok-4.5`);
            groqResponse = await axios.post(
              'https://api.x.ai/v1/chat/completions',
              {
                model: 'grok-4.5',
                messages,
                temperature: 0.7
              },
              {
                headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );
          } catch (grokErr) {
            console.warn(`[xAI API Warning] Flagship grok-4.5 failed: ${grokErr.message}. Attempting sub-fallback to grok-2...`);
            groqResponse = await axios.post(
              'https://api.x.ai/v1/chat/completions',
              {
                model: 'grok-2',
                messages,
                temperature: 0.7
              },
              {
                headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );
          }
          
          const text = groqResponse.data?.choices?.[0]?.message?.content;
          if (!text) {
            throw new Error('xAI Grok API returned an empty response structure.');
          }
          
          aiResponseText = text;
          successfulModel = 'grok';
          break; // Success! Exit fallback loop.
          
        } else if (currentModel === 'mistral') {
          const key = process.env.MISTRAL_API_KEY;
          if (!key) throw new Error('Mistral API key is not configured.');
          
          const messages = [
            { role: 'system', content: systemPrompt },
            ...contextMessages
          ];
          
          let mistralResponse;
          try {
            console.log(`[Mistral API] Attempting to call flagship model: mistral-large-latest`);
            mistralResponse = await axios.post(
              'https://api.mistral.ai/v1/chat/completions',
              {
                model: 'mistral-large-latest',
                messages,
                temperature: 0.7
              },
              {
                headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );
          } catch (mistralErr) {
            console.warn(`[Mistral API Warning] Flagship mistral-large-latest failed: ${mistralErr.message}. Attempting sub-fallback to mistral-medium-latest...`);
            mistralResponse = await axios.post(
              'https://api.mistral.ai/v1/chat/completions',
              {
                model: 'mistral-medium-latest',
                messages,
                temperature: 0.7
              },
              {
                headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );
          }
          
          const text = mistralResponse.data?.choices?.[0]?.message?.content;
          if (!text) {
            throw new Error('Mistral API returned an empty response structure.');
          }
          
          aiResponseText = text;
          successfulModel = 'mistral';
          break; // Success! Exit fallback loop.
        } else if (currentModel === 'openrouter') {
          const key = process.env.OPENROUTER_API_KEY;
          if (!key) throw new Error('OpenRouter API key is not configured.');
          
          const messages = [
            { role: 'system', content: systemPrompt },
            ...contextMessages
          ];
          
          console.log(`[OpenRouter API] Attempting to call model: google/gemini-2.5-flash`);
          const openrouterResponse = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: 'google/gemini-2.5-flash',
              messages,
              temperature: 0.7
            },
            {
              headers: {
                'Authorization': `Bearer ${key}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'Audex AI'
              },
              timeout: 15000
            }
          );
          
          const text = openrouterResponse.data?.choices?.[0]?.message?.content;
          if (!text) {
            throw new Error('OpenRouter API returned an empty response structure.');
          }
          
          aiResponseText = text;
          successfulModel = 'openrouter';
          break; // Success! Exit fallback loop.
          
        } else if (currentModel === 'groq') {
          const key = process.env.GROK_API_KEY;
          if (!key) throw new Error('Groq API key is not configured in GROK_API_KEY.');
          if (!key.startsWith('gsk_')) throw new Error('Key in GROK_API_KEY is not a valid Groq key.');
          
          const messages = [
            { role: 'system', content: systemPrompt },
            ...contextMessages
          ];
          
          let groqResponse;
          try {
            console.log(`[Groq API] Attempting to call model: llama-3.3-70b-versatile`);
            groqResponse = await axios.post(
              'https://api.groq.com/openai/v1/chat/completions',
              {
                model: 'llama-3.3-70b-versatile',
                messages,
                temperature: 0.7
              },
              {
                headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );
          } catch (groqErr) {
            console.warn(`[Groq API Warning] llama-3.3-70b-versatile failed: ${groqErr.message}. Attempting sub-fallback to llama-3.1-8b-instant...`);
            groqResponse = await axios.post(
              'https://api.groq.com/openai/v1/chat/completions',
              {
                model: 'llama-3.1-8b-instant',
                messages,
                temperature: 0.7
              },
              {
                headers: {
                  'Authorization': `Bearer ${key}`,
                  'Content-Type': 'application/json'
                },
                timeout: 15000
              }
            );
          }
          
          const text = groqResponse.data?.choices?.[0]?.message?.content;
          if (!text) {
            throw new Error('Groq API returned an empty response structure.');
          }
          
          aiResponseText = text;
          successfulModel = 'groq';
          break; // Success! Exit fallback loop.
        }
        
      } catch (err) {
        const errMsg = err.response ? JSON.stringify(err.response.data) : err.message;
        console.warn(`[Fallback Warning] Model "${currentModel}" failed:`, errMsg);
        apiErrorLogs.push(`${currentModel}: ${errMsg}`);
      }
    }
    
    // 6. If all fallbacks failed
    if (!aiResponseText) {
      console.error('[Chat API Error] All models in fallback chain failed:', apiErrorLogs);
      return res.status(500).json({ 
        error: 'All configured AI APIs (Gemini, Grok, Mistral, OpenRouter, and Groq) failed to respond. Please check server logs.',
        details: apiErrorLogs
      });
    }
    
    // Save AI response to DB
    const aiMessage = {
      sender: 'ai',
      text: aiResponseText,
      modelUsed: successfulModel
    };
    chat.messages.push(aiMessage);
    chat.updatedAt = new Date();
    await chat.save();
    
    res.json({
      message: aiMessage,
      chat
    });
    
  } catch (error) {
    console.error('Chat routing error:', error);
    res.status(500).json({ error: 'An internal error occurred during chat processing.' });
  }
});

// Route: Clear chat history
router.delete('/:auditId', auth, async (req, res) => {
  try {
    const { auditId } = req.params;
    let chat = await Chat.findOne({ auditId });
    if (chat) {
      chat.messages = [
        {
          sender: 'ai',
          text: 'Hello! I am your Audex AI Optimization Assistant. I have analyzed your subscription and API spend audit report. Feel free to ask me anything about the recommendations, migration steps, or compare different AI model tiers!',
          modelUsed: 'system'
        }
      ];
      chat.updatedAt = new Date();
      await chat.save();
    }
    res.json({ success: true, chat });
  } catch (error) {
    console.error('Failed to clear chat:', error);
    res.status(500).json({ error: 'Failed to clear chat history.' });
  }
});

module.exports = router;
