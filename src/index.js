import { Ai } from "@cloudflare/ai";
import { Hono } from 'hono'

import ui from './ui.html'
import write from './write.html'

const app = new Hono()

app.post('/notes', async (c) => {
  const ai = new Ai(c.env.AI)

  const { text } = await c.req.json();
  if (!text) c.throw(400, "Missing text");

  const { results } = await c.env.DATABASE.prepare("INSERT INTO notes (text) VALUES (?) RETURNING *")
    .bind(text)
    .run()

  const record = results.length ? results[0] : null

  if (!record) c.throw(500, "Fallo para crear el registro")

  const { data } = await ai.run('@cf/baai/bge-base-en-v1.5', { text: [text] })
  const values = data[0]

  if (!values) c.throw(500, "Fallo para generar el Vector Embebido")

  const { id } = record
  const inserted = await c.env.VECTOR_INDEX.upsert([
    {
      id: id.toString(),
      values,
    }
  ]);

  return c.json({ id, text, inserted });
})

app.get('/ui', async (c) => {
	return c.html(ui);
})
app.get('/', async (c) => {
	return c.html(write);
})
app.get('/write', async (c) => {
	return c.html(write);
})

app.get('/', async (c) => {
  const ai = new Ai(c.env.AI);

  const question = c.req.query('text') || "¿Cuánto es la raiz cuadrada de 64?"

  const embeddings = await ai.run('@cf/baai/bge-base-en-v1.5', { text: question })
  const vectors = embeddings.data[0]

  const SIMILARITY_CUTOFF = 0.75
  const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 1 });
  const vecIds = vectorQuery.matches
    .filter(vec => vec.score > SIMILARITY_CUTOFF)
    .map(vec => vec.vectorId)

  let notes = []
  if (vecIds.length) {
    const query = `SELECT * FROM notes WHERE id IN (${vecIds.join(", ")})`
    const { results } = await c.env.DATABASE.prepare(query).bind().all()
    if (results) notes = results.map(vec => vec.text)
  }

  const contextMessage = notes.length
    ? `Context:\n${notes.map(note => `- ${note}`).join("\n")}`
    : ""

  const systemPrompt = `Cuando respondas una pregunta o respondas, uusa el contexto provisto, si este resulta relevante, como la direccion anterior o nombre completo`

  const { response: answer } = await ai.run(
    '@cf/meta/llama-2-7b-chat-int8',
    {
      messages: [
        ...(notes.length ? [{ role: 'system', content: contextMessage }] : []),
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ]
    }
  )

  return c.text(answer);
})

app.onError((err, c) => {
  return c.text(err)
})

export default app
