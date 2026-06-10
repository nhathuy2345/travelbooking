const tours = {
  1: "Đà Lạt 3N2Đ",
  2: "Phú Quốc 4N3Đ",
  3: "Đà Nẵng - Hội An"
};

const params = new URLSearchParams(window.location.search);
const tourId = params.get("id");

document.getElementById("tour-name").innerText =
  tours[tourId] || "Tour chưa xác định";

document
.getElementById("booking-form")
.addEventListener("submit", function(e){

  e.preventDefault();

  const bookingData = {
    tourId,
    fullName:
      document.getElementById("fullName").value,

    email:
      document.getElementById("email").value,

    phone:
      document.getElementById("phone").value,

    people:
      document.getElementById("people").value,

    departureDate:
      document.getElementById("departureDate").value,

    note:
      document.getElementById("note").value
  };

  console.log(bookingData);

  document.getElementById("result").innerHTML =
    "<h3 style='color:lime'>Đặt tour thành công (demo)</h3>";
});