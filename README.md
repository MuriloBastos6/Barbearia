# Thiago Barbearia · Agendamento com sinal via Pix (versão Vercel)

- Segunda a sábado, horários de 1h30: 10:00, 11:30, 13:00, 14:30, 16:00, 17:30, 19:00 e 20:30 (o último termina às 22:00).
- O cliente escolhe o horário, paga R$ 20,00 de sinal por Pix (QR Code ou copia e cola) e toca em "Já fiz o Pix".
- O horário fica reservado por 15 minutos enquanto ele paga. Se não pagar, volta a ficar livre.
- Você confere o Pix no seu banco e toca em **Confirmar** no painel (`seusite.vercel.app/admin`).
- O Pix cai direto na sua chave, sem intermediário e sem taxa.

## Aviso importante sobre o plano gratuito

O plano gratuito da Vercel (Hobby) é, segundo a documentação oficial, restrito a uso pessoal e não
comercial. Uma barbearia que cobra sinal é uso comercial. Na prática, a Vercel pode pedir que você
migre para o plano pago (Pro, a partir de US$ 20 por mês) ou pausar o projeto. Leia os termos atuais
em vercel.com/docs/limits/fair-use-guidelines antes de depender disso.

## Passo a passo para publicar

1. **Crie uma conta no GitHub** (github.com) e um repositório novo, privado. Envie para ele os arquivos desta pasta (botão "Add file → Upload files" no site do GitHub; mantenha as pastas `api` e `public`).
2. **Crie uma conta na Vercel** (vercel.com) entrando com o GitHub.
3. Na Vercel: **Add New → Project**, escolha o repositório e clique em **Deploy**. Em "Framework Preset" deixe **Other**. (O primeiro deploy vai abrir o site, mas ainda sem banco de dados.)
4. **Crie o banco gratuito:** no projeto, abra a aba **Storage** (ou **Marketplace**), escolha **Upstash Redis** (plano Free), crie e conecte ao projeto. A Vercel adiciona as variáveis do banco sozinha (algo como `KV_REST_API_URL` e `KV_REST_API_TOKEN`).
5. **Configure suas variáveis:** em **Settings → Environment Variables**, adicione:

| Variável | O que colocar |
|---|---|
| `PIX_KEY` | Sua chave Pix **exatamente como está cadastrada no banco** (CPF, CNPJ, telefone, e-mail ou chave aleatória). |
| `ADMIN_PASSWORD` | Uma senha forte para o painel `/admin`. |
| `PIX_NAME` | (opcional) Nome no Pix. Padrão: THIAGO BARBEARIA. |
| `PIX_CITY` | (opcional) Cidade, sem acento. Padrão: SAO PAULO. |

6. **Faça um novo deploy** (aba Deployments → ⋯ → Redeploy) para as variáveis valerem.
7. Abra `seusite.vercel.app` para testar um agendamento e `seusite.vercel.app/admin` para o painel.

Dica: faça o primeiro teste com a conta de outra pessoa, pois alguns bancos não deixam pagar para a própria chave.

## Se o banco der erro ao ler o QR Code

O sistema já ajusta telefone para `+55DDDNUMERO`, e-mail em minúsculas e CPF/CNPJ só com números. Se o erro continuar:

1. Teste o botão de **Pix copia e cola** no app do banco, para saber se o problema é só o QR Code.
2. Confirme que a chave está ativa e é do tipo certo (uma chave de telefone, por exemplo, precisa estar registrada com esse número).
3. Confira na Vercel se o valor de `PIX_KEY` não tem espaços ou aspas a mais.

## Limites desta versão

- A confirmação do Pix é manual: o sistema não consegue saber se o dinheiro caiu. Sempre confira no banco antes de confirmar.
- Um cliente mal-intencionado pode tocar em "Já fiz o Pix" sem pagar. O horário só vira "confirmado" quando você confirma. Horários nesse estado aparecem como "Cliente disse que pagou" e ficam ocupados até você confirmar ou cancelar.
- Os registros somem sozinhos do banco depois de 60 dias.
- Para confirmação automática no futuro, dá para integrar um provedor (Mercado Pago, Asaas etc.) sem refazer o site.
