import type { BlogWalletDonation } from '@prisma/client';
import { prisma } from './prisma.js';
import { lockWallets, WALLET_DEBT_ERROR } from './wallet.js';

export interface WalletDonationInput {
  requestId: string;
  amountCents: number;
  note: string;
}

function replay(receipt: BlogWalletDonation, postId: string, input: WalletDonationInput) {
  return receipt.postId === postId && receipt.amountCents === input.amountCents && receipt.note === input.note
    ? { receipt }
    : { status: 409, error: 'Этот перевод уже использован с другими параметрами.' };
}

export async function previousBlogDonation(senderId: string, postId: string, input: WalletDonationInput) {
  const receipt = await prisma.blogWalletDonation.findUnique({
    where: { senderId_requestId: { senderId, requestId: input.requestId } },
  });
  return receipt ? replay(receipt, postId, input) : null;
}

export async function transferBlogDonation(senderId: string, recipientId: string, postId: string, input: WalletDonationInput) {
  if (senderId === recipientId) return { status: 400, error: 'Свою запись поддержать нельзя.' };
  return prisma.$transaction(async (tx) => {
    const wallets = await lockWallets(tx, [senderId, recipientId]);
    const old = await tx.blogWalletDonation.findUnique({
      where: { senderId_requestId: { senderId, requestId: input.requestId } },
    });
    if (old) return replay(old, postId, input);
    const [post] = await tx.$queryRaw<Array<{ title: string }>>`
      SELECT title FROM blog_posts WHERE id = ${postId} AND "authorId" = ${recipientId}
        AND published AND audience <> 'self' FOR SHARE
    `;
    if (!post || wallets.length !== 2) return { status: 404, error: 'Запись не найдена.' };
    const debit = BigInt(input.amountCents);
    const sender = wallets.find((wallet) => wallet.id === senderId)!;
    if (sender.aiBalanceCents < 0) return { status: 409, error: WALLET_DEBT_ERROR };
    if (sender.walletBalanceCents < debit) {
      return { status: 409, error: 'На кошельке OpenWritter недостаточно BYN.' };
    }
    await tx.user.update({ where: { id: senderId }, data: { walletBalanceCents: { decrement: debit } }, select: { id: true } });
    await tx.user.update({ where: { id: recipientId }, data: { walletBalanceCents: { increment: debit } }, select: { id: true } });
    const receipt = await tx.blogWalletDonation.create({
      data: { ...input, senderId, authorId: recipientId, postId, postTitle: post.title },
    });
    return { receipt };
  });
}
