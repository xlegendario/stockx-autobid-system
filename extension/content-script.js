console.log("StockX Autobid content script loaded");

// Wait until page is fully loaded
window.addEventListener("load", () => {
  console.log("Page loaded, checking if StockX product page...");

  const isProductPage = window.location.pathname.length > 1;

  if (!isProductPage) {
    console.log("Not a product page");
    return;
  }

  console.log("Product page detected:", window.location.href);

  // Example: find size buttons
  const sizeButtons = document.querySelectorAll('button');

  console.log("Found buttons:", sizeButtons.length);

  // DEBUG: log some button texts
  sizeButtons.forEach((btn, i) => {
    if (i < 10) {
      console.log("Button text:", btn.innerText);
    }
  });
});
