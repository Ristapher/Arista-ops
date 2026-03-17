1) Put email_service.py and requirements-email-service.txt in a folder on your computer.
2) Install the packages:
   py -m pip install -r requirements-email-service.txt
3) Create a .env file next to email_service.py using env.email-example as the template.
4) Set the same SERVICE_API_KEY in app/.env.local and email-service/.env.
5) Turn on 2-Step Verification on the Gmail account and generate a Gmail App Password.
6) Start the service:
   py email_service.py
7) Test health in the browser:
   http://127.0.0.1:5050/health
8) Test email with PowerShell:
   Invoke-RestMethod -Method Post -Uri http://127.0.0.1:5050/send-invoice-email -Headers @{'x-api-key'='change-me-local'} -ContentType 'application/json' -Body '{"to_email":"YOUR_EMAIL_HERE","customer_name":"Test Customer","amount":125.00,"status":"Unpaid","job_number":"JOB-TEST-1001","notes":"Test invoice email."}'
