export default function CheckoutSuccessPage() {
  return (
    <div className="min-h-screen bg-white flex flex-col items-center justify-center px-4 py-16 text-center">
      <div className="max-w-md w-full space-y-4">
        <h1 className="text-3xl font-bold text-gray-900">You&apos;re all set!</h1>
        <p className="text-gray-500">
          Your trial has started. Check your texts — your training plan is on its way.
        </p>
        <p className="text-sm text-gray-400">
          You can close this window.
        </p>
      </div>
    </div>
  );
}
