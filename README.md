# Thiago Barbearia · Agendamento com sinal (versão Vercel)

- Segunda a sábado, horários de 1h30: 10:00, 11:30, 13:00, 14:30, 16:00, 17:30, 19:00 e 20:30 (o último termina às 22:00).
- O cliente escolhe o horário e paga R$ 20,00 de sinal. O horário fica reservado por 15 minutos
  enquanto ele paga. Se não pagar, volta a ficar livre.
- Há duas formas de receber o sinal:
  - **Mercado Pago** (recomendado): o cliente paga por Pix, cartão de crédito ou débito na página
    do Mercado Pago, e o horário se confirma sozinho quando o pagamento é aprovado.
  - **Pix manual** (se o Mercado Pago não estiver configurado): o Pix cai direto na sua chave, sem
    taxa, mas você confere no banco e toca em **Confirmar** no painel (`seusite.vercel.app/admin`).
- O cliente pode criar uma conta (WhatsApp + senha) no botão **Entrar** e ver o histórico dos agendamentos dele.

## Conta do cliente

- Agendamentos feitos com a conta logada entram no histórico dela. Um agendamento feito sem login
  também entra, se o cliente criar a conta ou entrar **no mesmo aparelho** logo depois de agendar.
- A senha é guardada só como hash (scrypt), nunca em texto. Depois de 10 senhas erradas, o login
  daquele WhatsApp fica bloqueado por 10 minutos.
- **Trocar senha:** logado, o cliente toca em **Trocar senha** em "Meus agendamentos".
- **Esqueci minha senha:** o cliente pede um código pelo WhatsApp. No painel `/admin`, em
  "Cliente esqueceu a senha", digite o WhatsApp dele e toque em **Gerar código**. O botão
  "Enviar pelo WhatsApp" já abre a conversa com a mensagem pronta. O código vale 30 minutos e
  para de valer depois de 5 tentativas erradas. Trocar a senha desconecta a conta dos outros aparelhos.
- Antes de mandar o código, confirme que quem está pedindo é mesmo o dono daquele número.
- O WhatsApp não é verificado no cadastro, por isso o histórico mostra só agendamentos ligados à conta,
  e não tudo o que já foi marcado com aquele número.

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
| `MP_ACCESS_TOKEN` | Access Token de produção do Mercado Pago (veja a seção "Mercado Pago"). Com ele, `PIX_KEY` não é necessária. |
| `PIX_KEY` | Só para o Pix manual: sua chave Pix **exatamente como está cadastrada no banco** (CPF, CNPJ, telefone, e-mail ou chave aleatória). |
| `ADMIN_PASSWORD` | Uma senha forte para o painel `/admin`. |
| `PIX_NAME` | (opcional) Nome no Pix. Padrão: THIAGO BARBEARIA. |
| `PIX_CITY` | (opcional) Cidade, sem acento. Padrão: SAO PAULO. |
| `WHATSAPP` | (opcional) WhatsApp da barbearia com DDD. Mostra ao cliente um botão para pedir o código de nova senha. |

6. **Faça um novo deploy** (aba Deployments → ⋯ → Redeploy) para as variáveis valerem.
7. Abra `seusite.vercel.app` para testar um agendamento e `seusite.vercel.app/admin` para o painel.

Dica: faça o primeiro teste com a conta de outra pessoa, pois alguns bancos não deixam pagar para a própria chave.

## Mercado Pago (Pix, crédito e débito)

1. Entre em **mercadopago.com.br/developers/panel** com a conta do Mercado Pago da barbearia e
   crie uma aplicação (tipo "Pagamentos online", produto "Checkout Pro").
2. Em **Credenciais de produção**, copie o **Access Token** (começa com `APP_USR-`).
3. Na Vercel, em **Settings → Environment Variables**, crie `MP_ACCESS_TOKEN` com esse valor e faça
   um **Redeploy**. Pronto: o site passa a usar o Mercado Pago no lugar do Pix manual.
4. Para o Pix aparecer como opção, a conta do Mercado Pago precisa ter uma **chave Pix cadastrada**
   (app do Mercado Pago → Pix → Minhas chaves).

Como funciona:
- O site avisa o Mercado Pago do endereço de notificação sozinho; não precisa configurar webhook no painel.
  Mesmo se o aviso atrasar, a página do cliente consulta o pagamento e confirma do mesmo jeito.
- O pagamento é sempre em 1 vez. Boleto fica desligado, porque demora dias para compensar.
- Se o cliente pagar depois de a reserva vencer e o horário já tiver ido para outra pessoa, o valor é
  **devolvido automaticamente**. Se a devolução falhar, o agendamento aparece no painel como
  "Devolver sinal no Mercado Pago": devolva pelo app do Mercado Pago e toque em **Cancelar**.
- Cancelar um agendamento pago no painel **não devolve** o sinal sozinho. Se quiser devolver,
  faça pelo app do Mercado Pago (Atividade → pagamento → Devolver).
- O Mercado Pago cobra uma taxa por venda (Pix e cartão têm taxas diferentes, e o prazo para o
  dinheiro ficar disponível muda a taxa). Confira as taxas atuais da sua conta no app do Mercado Pago.
- `SITE_URL` (opcional): o endereço do site, ex. `https://thiagobarbearia.com.br`. Só é preciso se
  você usar um domínio próprio e quiser que o Mercado Pago devolva o cliente para ele.
- Para testar sem cobrar de verdade, use o Access Token de **Credenciais de teste** e as contas de
  teste do painel do Mercado Pago. Depois troque pelo de produção.

## Se o banco der erro ao ler o QR Code

O sistema já ajusta telefone para `+55DDDNUMERO`, e-mail em minúsculas e CPF/CNPJ só com números. Se o erro continuar:

1. Teste o botão de **Pix copia e cola** no app do banco, para saber se o problema é só o QR Code.
2. Confirme que a chave está ativa e é do tipo certo (uma chave de telefone, por exemplo, precisa estar registrada com esse número).
3. Confira na Vercel se o valor de `PIX_KEY` não tem espaços ou aspas a mais.

## Limites desta versão

- No Pix manual (sem Mercado Pago), a confirmação é manual: o sistema não consegue saber se o dinheiro caiu. Sempre confira no banco antes de confirmar.
- No Pix manual, um cliente mal-intencionado pode tocar em "Já fiz o Pix" sem pagar. O horário só vira "confirmado" quando você confirma. Horários nesse estado aparecem como "Cliente disse que pagou" e ficam ocupados até você confirmar ou cancelar.
- Os registros somem sozinhos do banco depois de 60 dias, e por isso o histórico do cliente mostra só os últimos 60 dias.
